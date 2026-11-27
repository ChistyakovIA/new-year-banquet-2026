begin;

alter table public.banquet_wishes add column details jsonb not null default '{}'::jsonb;
create table public.banquet_seating_rules (
  id integer primary key,
  guest_id integer not null references public.guests(id) on delete cascade,
  seat integer check (seat between 1 and 13),
  neighbor integer references public.guests(id) on delete cascade,
  required boolean not null default false,
  apart boolean not null default false,
  check (guest_id is distinct from neighbor)
);
alter table public.banquet_seating_rules enable row level security;
revoke all on public.banquet_seating_rules from public, anon, authenticated;

drop function public.banquet_save_wish(integer,integer,integer,integer,text,text,text);

create or replace function public.banquet_save_wish(
  expected_revision integer, wanted_seat integer, wanted_neighbor integer, wanted_menu integer,
  wanted_salad text, wanted_hot text, wanted_note text, wanted_details jsonb default null
)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  member_id integer;
  current_revision integer;
  old_wish jsonb;
  new_wish jsonb;
begin
  select g.id into member_id from public.guests g where g.user_id = (select auth.uid()) for update;
  if member_id is null then
    raise exception using errcode = '42501', message = 'banquet_membership_required';
  end if;
  if wanted_details is not null and (
    jsonb_typeof(wanted_details) is distinct from 'object'
    or jsonb_typeof(wanted_details->'items') is distinct from 'array'
    or coalesce(wanted_details->'layout', 'null'::jsonb) not in ('null'::jsonb, '1'::jsonb, '2'::jsonb)
    or pg_column_size(wanted_details) > 4096
  ) then
    raise exception using errcode='22023', message='banquet_invalid_wish_details';
  end if;
  if wanted_details is not null and (jsonb_array_length(wanted_details->'items') > 15 or exists (
    select 1 from jsonb_array_elements(wanted_details->'items') as item
    where jsonb_typeof(item) <> 'object'
      or coalesce(item->>'kind','') not in ('dish','drink')
      or jsonb_typeof(item->'name') is distinct from 'string'
      or coalesce(length(item->>'name'),0) not between 1 and 100
  )) then
    raise exception using errcode='22023', message='banquet_invalid_wish_items';
  end if;
  select w.revision, to_jsonb(w) into current_revision, old_wish
    from public.banquet_wishes w where w.guest_id = member_id;
  current_revision := coalesce(current_revision, 0);
  if expected_revision is distinct from current_revision then
    raise exception using errcode = '40001', message = 'banquet_wish_changed';
  end if;
  insert into public.banquet_wishes(guest_id, revision, seat, neighbor, menu, salad, hot, note, details)
  values (member_id, current_revision + 1, wanted_seat, wanted_neighbor, wanted_menu, wanted_salad, wanted_hot, coalesce(wanted_note, ''), coalesce(wanted_details, '{}'::jsonb))
  on conflict (guest_id) do update set
    revision = excluded.revision, seat = excluded.seat, neighbor = excluded.neighbor,
    menu = excluded.menu, salad = excluded.salad, hot = excluded.hot, note = excluded.note,
    details = coalesce(wanted_details, banquet_wishes.details)
  returning to_jsonb(banquet_wishes) into new_wish;
  insert into public.banquet_history(actor_id, kind, revision, previous_wish, current_wish)
    values (member_id, 'wish', current_revision + 1, old_wish, new_wish);
  update public.banquet_signal set revision = revision + 1 where id = 1;
  return current_revision + 1;
end
$$;

create or replace function public.banquet_snapshot()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  member_id integer;
  organizer boolean;
begin
  select g.id, g.admin into member_id, organizer from public.guests g where g.user_id = (select auth.uid());
  if member_id is null then
    raise exception using errcode = '42501', message = 'banquet_membership_required';
  end if;
  return jsonb_build_object(
    'member', member_id, 'admin', organizer,
    'menu_authors', coalesce((select jsonb_object_agg(menu, author) from public.banquet_menu_authors), '{}'::jsonb),
    'guests', (
      select jsonb_agg(jsonb_build_object(
        'id', g.id, 'name', g.profile->>1,
        'drink_group', case
          when g.profile->>2 in ('strong','other','none') then g.profile->>2
          else 'unknown'
        end,
        'profile', case when organizer or g.id = member_id then g.profile else null end
      ) order by g.id)
      from public.guests g
    ),
    'seating_rules', case when organizer then (
      select coalesce(jsonb_agg(to_jsonb(r) - 'id' order by r.id), '[]'::jsonb)
      from public.banquet_seating_rules r
    ) else '[]'::jsonb end,
    'funding', case when organizer then (
      select jsonb_build_object('records', jsonb_agg(to_jsonb(f) order by f.guest_id))
      from public.banquet_guest_facts f
    ) else null end,
    'plan', (select to_jsonb(p) from public.banquet_plan p where id = 1),
    'wishes', coalesce((
      select jsonb_agg(to_jsonb(w) order by w.guest_id)
      from public.banquet_wishes w where organizer or w.guest_id = member_id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id, 'at', h.happened_at, 'kind', h.kind, 'revision', h.revision,
        'actor', g.profile->>1,
        'before', case
          when h.kind = 'wish' and (organizer or h.actor_id = member_id) then h.previous_wish
          when h.kind in ('plan','layout') and organizer then h.previous_plan
        end,
        'after', case
          when h.kind = 'wish' and (organizer or h.actor_id = member_id) then h.current_wish
          when h.kind in ('plan','layout') and organizer then h.current_plan
        end
      ) order by h.id desc)
      from (select * from public.banquet_history
            where kind in ('plan','layout') or organizer or actor_id = member_id
            order by id desc) h
      left join public.guests g on g.id = h.actor_id
    ), '[]'::jsonb)
  );
end
$$;

revoke execute on function public.banquet_save_wish(integer,integer,integer,integer,text,text,text,jsonb) from public, anon;
grant execute on function public.banquet_save_wish(integer,integer,integer,integer,text,text,text,jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
