begin;

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
  select w.revision into current_revision
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
    details = coalesce(wanted_details, banquet_wishes.details);
  update public.banquet_signal set revision = revision + 1 where id = 1;
  return current_revision + 1;
end
$$;

create or replace function public.banquet_publish(
  expected_revision integer, approved_menu integer, approved_seats integer[],
  approved_adjustments jsonb, approved_assignments jsonb, approved_fee integer, approved_tables integer default null
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
  if member_id is null then
    raise exception using errcode = '42501', message = 'banquet_organizer_required';
  end if;
  if (approved_tables is not null and approved_tables not in (1, 2))
    or approved_menu is null or approved_menu not between 0 and 3 or approved_fee is null or approved_fee not between 0 and 39000
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
    adjustments = approved_adjustments, assignments = approved_assignments,
    table_count = coalesce(approved_tables, old_plan.table_count)
  where id = 1 returning * into new_plan;
  update public.banquet_signal set revision = revision + 1 where id = 1;
  return new_plan.revision;
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
    'seating_rules', '[]'::jsonb,
    'funding', case when organizer then (
      select jsonb_build_object('records', jsonb_agg(to_jsonb(f) order by f.guest_id))
      from public.banquet_guest_facts f
    ) else null end,
    'plan', (select to_jsonb(p) from public.banquet_plan p where id = 1),
    'wishes', coalesce((
      select jsonb_agg(to_jsonb(w) order by w.guest_id)
      from public.banquet_wishes w where organizer or w.guest_id = member_id
    ), '[]'::jsonb),
    'events', '[]'::jsonb
  );
end
$$;

delete from public.banquet_history;

delete from public.banquet_seating_rules;

update public.banquet_signal set revision = revision + 1 where id = 1;

notify pgrst, 'reload schema';

commit;
