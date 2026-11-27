begin;

create table public.guests (
  id integer primary key check (id between 0 and 12),
  user_id uuid unique references auth.users(id) on delete set null,
  admin boolean not null default false,
  login_surname text check (length(btrim(login_surname)) between 1 and 80),
  profile jsonb not null check (jsonb_typeof(profile) = 'array' and jsonb_array_length(profile) = 7)
);

create table public.banquet_login_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade
);
create index banquet_login_sessions_user_id on public.banquet_login_sessions(user_id);

create table public.banquet_plan (
  id integer primary key check (id = 1),
  revision integer not null default 0 check (revision >= 0),
  menu integer check (menu between 0 and 3),
  seats integer[] not null default array[0,3,4,5,6,11,12,1,2,7,8,9,10],
  adjustments jsonb not null default '[]',
  assignments jsonb not null default '{}',
  fee integer not null default 0 check (fee between 0 and 39000)
);
insert into public.banquet_plan(id) values (1);

create table public.banquet_menu_authors (
  menu integer primary key check (menu between 0 and 3),
  author text not null check (length(author) <= 120)
);

create table public.banquet_wishes (
  guest_id integer primary key references public.guests(id) on delete cascade,
  revision integer not null check (revision > 0),
  seat integer check (seat between 1 and 13),
  neighbor integer references public.guests(id),
  menu integer check (menu between 0 and 3),
  salad text check (length(salad) <= 100),
  hot text check (length(hot) <= 100),
  note text not null check (length(note) <= 1200),
  check (neighbor is distinct from guest_id)
);

create table public.banquet_history (
  id bigint generated always as identity primary key,
  happened_at timestamptz not null default now(),
  actor_id integer references public.guests(id) on delete set null,
  kind text not null check (kind in ('plan', 'wish')),
  revision integer not null,
  previous_plan jsonb,
  current_plan jsonb
);

create table public.banquet_signal (
  id integer primary key check (id = 1),
  revision bigint not null default 0
);
insert into public.banquet_signal(id) values (1);

alter table public.guests enable row level security;
alter table public.banquet_login_sessions enable row level security;
alter table public.banquet_menu_authors enable row level security;
alter table public.banquet_plan enable row level security;
alter table public.banquet_wishes enable row level security;
alter table public.banquet_history enable row level security;
alter table public.banquet_signal enable row level security;
revoke all on public.guests, public.banquet_login_sessions, public.banquet_menu_authors, public.banquet_plan, public.banquet_wishes, public.banquet_history, public.banquet_signal from public, anon, authenticated;
revoke all on sequence public.banquet_history_id_seq from public, anon, authenticated;

create function public.banquet_confirm_surname(entered_surname text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  cyrillic_upper constant text := 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ';
  cyrillic_lower constant text := 'абвгдеежзийклмнопрстуфхцчшщъыьэюя';
begin
  if session_id is null or entered_surname is null or length(entered_surname) not between 1 and 80
    or not coalesce(auth.jwt()->'amr' @> '[{"method":"otp"}]'::jsonb, false) then
    return false;
  end if;
  if not exists (
    select 1 from public.guests g
    join auth.users u on u.id = g.user_id
    where g.user_id = account_id and u.phone_confirmed_at is not null and nullif(u.phone, '') is not null
      and ltrim(u.phone, '+') = ltrim(auth.jwt()->>'phone', '+')
      and lower(translate(btrim(g.login_surname), cyrillic_upper || 'ё', cyrillic_lower || 'е'))
        = lower(translate(btrim(entered_surname), cyrillic_upper || 'ё', cyrillic_lower || 'е'))
  ) then
    return false;
  end if;
  insert into public.banquet_login_sessions(id, user_id) values (session_id, account_id)
  on conflict (id) do nothing;
  return true;
end
$$;
revoke execute on function public.banquet_confirm_surname(text) from public, anon;
grant execute on function public.banquet_confirm_surname(text) to authenticated;

create function public.banquet_is_member()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.guests g
    join public.banquet_login_sessions s on s.user_id = g.user_id
    where g.user_id = (select auth.uid())
      and s.id = (select nullif(auth.jwt()->>'session_id', '')::uuid)
  )
$$;
revoke execute on function public.banquet_is_member() from public, anon;
grant execute on function public.banquet_is_member() to authenticated;
grant select on public.banquet_signal to authenticated;
create policy banquet_members_read_signal on public.banquet_signal
  for select to authenticated using ((select public.banquet_is_member()));
alter publication supabase_realtime add table public.banquet_signal;

create function public.banquet_snapshot()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  member_id integer;
  organizer boolean;
begin
  select g.id, g.admin into member_id, organizer from public.guests g where g.user_id = (select auth.uid());
  if member_id is null or not public.banquet_is_member() then
    raise exception using errcode = '42501', message = 'banquet_membership_required';
  end if;

  return jsonb_build_object(
    'member', member_id, 'admin', organizer,
    'menu_authors', coalesce((select jsonb_object_agg(menu, author) from public.banquet_menu_authors), '{}'::jsonb),
    'guests', (
      select jsonb_agg(jsonb_build_object(
        'id', g.id, 'name', g.profile->>1,
        'profile', case when organizer or g.id = member_id then g.profile else null end
      ) order by g.id)
      from public.guests g
    ),
    'plan', (select to_jsonb(p) from public.banquet_plan p where id = 1),
    'wishes', coalesce((
      select jsonb_agg(to_jsonb(w) order by w.guest_id)
      from public.banquet_wishes w where organizer or w.guest_id = member_id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id, 'at', h.happened_at, 'kind', h.kind, 'revision', h.revision,
        'actor', case when h.kind = 'plan' or organizer or h.actor_id = member_id then g.profile->>1 else null end,
        'before', case when organizer then h.previous_plan else null end,
        'after', case when organizer then h.current_plan else null end
      ) order by h.id desc)
      from (select * from public.banquet_history
            where kind = 'plan' or organizer or actor_id = member_id
            order by id desc limit 60) h
      left join public.guests g on g.id = h.actor_id
    ), '[]'::jsonb)
  );
end
$$;

create function public.banquet_save_wish(
  expected_revision integer, wanted_seat integer, wanted_neighbor integer, wanted_menu integer,
  wanted_salad text, wanted_hot text, wanted_note text
)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  member_id integer;
  current_revision integer := 0;
begin
  select g.id into member_id from public.guests g where g.user_id = (select auth.uid()) for update;
  if member_id is null or not public.banquet_is_member() then
    raise exception using errcode = '42501', message = 'banquet_membership_required';
  end if;
  select coalesce((select revision from public.banquet_wishes where guest_id = member_id), 0) into current_revision;
  if expected_revision is distinct from current_revision then
    raise exception using errcode = '40001', message = 'banquet_wish_changed';
  end if;

  insert into public.banquet_wishes(guest_id, revision, seat, neighbor, menu, salad, hot, note)
  values (member_id, current_revision + 1, wanted_seat, wanted_neighbor, wanted_menu, wanted_salad, wanted_hot, coalesce(wanted_note, ''))
  on conflict (guest_id) do update set
    revision = excluded.revision, seat = excluded.seat, neighbor = excluded.neighbor,
    menu = excluded.menu, salad = excluded.salad, hot = excluded.hot, note = excluded.note;
  insert into public.banquet_history(actor_id, kind, revision) values (member_id, 'wish', current_revision + 1);
  update public.banquet_signal set revision = revision + 1 where id = 1;
  return current_revision + 1;
end
$$;

create function public.banquet_publish(
  expected_revision integer, approved_menu integer, approved_seats integer[],
  approved_adjustments jsonb, approved_assignments jsonb, approved_fee integer
)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  member_id integer;
  old_plan public.banquet_plan;
  new_plan public.banquet_plan;
  item jsonb;
  allocation record;
  dish_counts integer[][] := array[[5,1,1,1,0,0,11],[5,1,1,2,0,0,11],[5,1,1,2,0,0,11],[5,4,3,4,2,0,11]];
  stage integer;
begin
  select g.id into member_id
    from public.guests g where g.user_id = (select auth.uid()) and g.admin for share;
  if member_id is null or not public.banquet_is_member() then
    raise exception using errcode = '42501', message = 'banquet_organizer_required';
  end if;
  if approved_menu is null or approved_menu not between 0 and 3 or approved_fee is null or approved_fee not between 0 and 39000
    or cardinality(approved_seats) is distinct from 13 or (select count(distinct n) from unnest(approved_seats) n where n between 0 and 12) <> 13
    or jsonb_typeof(approved_adjustments) is distinct from 'array'
    or jsonb_typeof(approved_assignments) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'banquet_invalid_plan';
  end if;
  if jsonb_array_length(approved_adjustments) > 64 or pg_column_size(approved_assignments) > 4096 then
    raise exception using errcode = '22023', message = 'banquet_invalid_plan';
  end if;
  for item in select value from jsonb_array_elements(approved_adjustments) loop
    if jsonb_typeof(item) <> 'array' or jsonb_array_length(item) <> 4
      or exists (select 1 from jsonb_array_elements(item) v where jsonb_typeof(v) <> 'number' or v::text !~ '^[0-9]{1,5}$') then
      raise exception using errcode = '22023', message = 'banquet_invalid_adjustment';
    end if;
    stage := (item->>0)::integer;
    if stage not between 0 and 6 or (item->>1)::integer >= dish_counts[approved_menu+1][stage+1]
      or (item->>2)::integer > 300 or (item->>3)::integer > 39000 then
      raise exception using errcode = '22023', message = 'banquet_invalid_adjustment';
    end if;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(approved_adjustments) v
    group by v->0, v->1 having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'banquet_duplicate_adjustment';
  end if;
  for allocation in select key, value from jsonb_each(approved_assignments) loop
    if allocation.key !~ '^(0|[1-9]|1[0-2])$' or jsonb_typeof(allocation.value) <> 'object'
      or (select count(*) from jsonb_each(allocation.value)) > 2
      or exists (
        select 1 from jsonb_each(allocation.value) a
        where key not in ('salad','hot') or jsonb_typeof(value) <> 'number' or value::text !~ '^[0-9]{1,2}$'
      ) then
      raise exception using errcode = '22023', message = 'banquet_invalid_assignment';
    end if;
    if (allocation.value->>'salad')::integer >= dish_counts[approved_menu+1][2]
      or (allocation.value->>'hot')::integer >= dish_counts[approved_menu+1][3] then
      raise exception using errcode = '22023', message = 'banquet_invalid_assignment';
    end if;
  end loop;

  select * into old_plan from public.banquet_plan where id = 1 for update;
  if old_plan.revision is distinct from expected_revision then
    raise exception using errcode = '40001', message = 'banquet_plan_changed';
  end if;
  update public.banquet_plan
  set revision = revision + 1, menu = approved_menu, seats = approved_seats, fee = approved_fee,
    adjustments = approved_adjustments, assignments = approved_assignments
  where id = 1 returning * into new_plan;
  insert into public.banquet_history(actor_id, kind, revision, previous_plan, current_plan)
  values (member_id, 'plan', new_plan.revision, to_jsonb(old_plan), to_jsonb(new_plan));
  update public.banquet_signal set revision = revision + 1 where id = 1;
  return new_plan.revision;
end
$$;

revoke execute on function public.banquet_snapshot() from public, anon;
revoke execute on function public.banquet_save_wish(integer,integer,integer,integer,text,text,text) from public, anon;
revoke execute on function public.banquet_publish(integer,integer,integer[],jsonb,jsonb,integer) from public, anon;
grant execute on function public.banquet_snapshot() to authenticated;
grant execute on function public.banquet_save_wish(integer,integer,integer,integer,text,text,text) to authenticated;
grant execute on function public.banquet_publish(integer,integer,integer[],jsonb,jsonb,integer) to authenticated;

commit;
