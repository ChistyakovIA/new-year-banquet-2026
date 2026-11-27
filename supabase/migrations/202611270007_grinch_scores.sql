begin;

create table public.banquet_grinch_scores (
  guest_id integer primary key references public.guests(id) on delete cascade,
  centiseconds integer not null check (centiseconds between 1 and 8640000),
  friendly integer not null check (friendly between 0 and 10000),
  misses integer not null check (misses between 0 and 10000)
);
alter table public.banquet_grinch_scores enable row level security;
revoke all on public.banquet_grinch_scores from public, anon, authenticated;

create function public.banquet_grinch_ranking()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.banquet_is_member() then
    raise exception using errcode='42501', message='banquet_membership_required';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', g.profile->>0, 'centiseconds', s.centiseconds, 'friendly', s.friendly, 'misses', s.misses
    ) order by s.centiseconds nulls last, s.friendly, s.misses, g.id)
    from public.guests g left join public.banquet_grinch_scores s on s.guest_id=g.id
  ), '[]'::jsonb);
end
$$;

create function public.banquet_grinch_record(
  game_centiseconds integer, game_friendly integer, game_misses integer
)
returns jsonb
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
  insert into public.banquet_grinch_scores as best(guest_id,centiseconds,friendly,misses)
  values (member_id,game_centiseconds,game_friendly,game_misses)
  on conflict (guest_id) do update
    set centiseconds=excluded.centiseconds, friendly=excluded.friendly, misses=excluded.misses
    where (excluded.centiseconds,excluded.friendly,excluded.misses) < (best.centiseconds,best.friendly,best.misses);
  return public.banquet_grinch_ranking();
end
$$;

revoke execute on function public.banquet_grinch_ranking() from public, anon;
revoke execute on function public.banquet_grinch_record(integer,integer,integer) from public, anon;
grant execute on function public.banquet_grinch_ranking() to authenticated;
grant execute on function public.banquet_grinch_record(integer,integer,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
