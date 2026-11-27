begin;

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
        'drink_group', case when g.profile->>2 in ('strong','other') then g.profile->>2 else 'unknown' end,
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

commit;
