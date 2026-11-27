begin;

create table public.banquet_extra_orders (
  guest_id integer not null references public.guests(id) on delete cascade,
  id uuid not null,
  name text not null check (length(name) between 1 and 120 and name = btrim(name)),
  quantity integer not null check (quantity between 1 and 200),
  price_cents integer check (price_cents between 0 and 10000000),
  volume_ml integer check (volume_ml between 1 and 20000),
  created_at timestamptz not null default now(),
  primary key (guest_id,id)
);

alter table public.banquet_extra_orders enable row level security;
revoke all on public.banquet_extra_orders from public, anon, authenticated;

create function public.banquet_add_extra_order(
  order_id uuid, order_name text, order_quantity integer,
  order_price_cents integer default null, order_volume_ml integer default null
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  member_id integer;
begin
  select id into member_id from public.guests where user_id=(select auth.uid());
  if member_id is null then
    raise exception using errcode='42501', message='banquet_membership_required';
  end if;
  insert into public.banquet_extra_orders as o(guest_id,id,name,quantity,price_cents,volume_ml)
  values (member_id,order_id,btrim(order_name),order_quantity,order_price_cents,order_volume_ml)
  on conflict (guest_id,id) do nothing;
  if found then
    update public.banquet_signal set revision=revision+1 where id=1;
  elsif not exists (
    select 1 from public.banquet_extra_orders o
    where o.guest_id=member_id and o.id=order_id and
      (o.name,o.quantity,o.price_cents,o.volume_ml)
      is not distinct from (btrim(order_name),order_quantity,order_price_cents,order_volume_ml)
  ) then
    raise exception using errcode='22023', message='extra_order_id_conflict';
  end if;
end
$$;

create function public.banquet_remove_extra_order(order_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  member_id integer;
begin
  select id into member_id from public.guests where user_id=(select auth.uid());
  if member_id is null then
    raise exception using errcode='42501', message='banquet_membership_required';
  end if;
  delete from public.banquet_extra_orders o where o.guest_id=member_id and o.id=order_id;
  if found then
    update public.banquet_signal set revision=revision+1 where id=1;
  end if;
end
$$;

revoke execute on function public.banquet_add_extra_order(uuid,text,integer,integer,integer) from public, anon;
revoke execute on function public.banquet_remove_extra_order(uuid) from public, anon;
grant execute on function public.banquet_add_extra_order(uuid,text,integer,integer,integer) to authenticated;
grant execute on function public.banquet_remove_extra_order(uuid) to authenticated;

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
    'extra_orders', coalesce((
      select jsonb_agg(to_jsonb(o) order by o.created_at, o.id)
      from public.banquet_extra_orders o where organizer or o.guest_id=member_id
    ), '[]'::jsonb),
    'events', '[]'::jsonb
  );
end
$$;

notify pgrst, 'reload schema';
commit;
