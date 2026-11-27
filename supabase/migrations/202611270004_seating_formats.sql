begin;

alter table public.banquet_plan add column table_count integer not null default 2 check (table_count in (1, 2));

-- The default argument preserves clients of the previous six-argument API.
drop function public.banquet_publish(integer,integer,integer[],jsonb,jsonb,integer);

create function public.banquet_publish(
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
  insert into public.banquet_history(actor_id, kind, revision, previous_plan, current_plan)
  values (member_id, 'plan', new_plan.revision, to_jsonb(old_plan), to_jsonb(new_plan));
  update public.banquet_signal set revision = revision + 1 where id = 1;
  return new_plan.revision;
end
$$;

revoke execute on function public.banquet_publish(integer,integer,integer[],jsonb,jsonb,integer,integer) from public, anon;
grant execute on function public.banquet_publish(integer,integer,integer[],jsonb,jsonb,integer,integer) to authenticated;

notify pgrst, 'reload schema';
commit;
