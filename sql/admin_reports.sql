-- Run after auth.sql, lecturer_dashboard.sql, and student_dashboard.sql.
-- Adds admin management access and lecturer reporting access.
alter table public.profiles add column if not exists email text not null default '';
update public.profiles p
set email = coalesce(u.email, '')
from auth.users u
where u.id = p.id and p.email = '';

create or replace function public.current_user_has_role(required_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = required_role
  );
$$;

revoke all on function public.current_user_has_role(text) from public, anon, authenticated;
grant execute on function public.current_user_has_role(text) to authenticated;

create or replace function public.create_student_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    'student'
  );
  return new;
end;
$$;

drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles"
  on public.profiles for select to authenticated
  using (public.current_user_has_role('admin'));

drop policy if exists "Lecturers can view enrolled student profiles" on public.profiles;
create policy "Lecturers can view enrolled student profiles"
  on public.profiles for select to authenticated
  using (
    exists (
      select 1
      from public.course_enrollments e
      join public.courses c on c.id = e.course_id
      where e.student_id = profiles.id and c.lecturer_id = (select auth.uid())
    )
  );

create or replace function public.admin_set_user_role(target_user_id uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_role text;
  administrator_count integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ) then
    raise exception 'Administrator access is required.';
  end if;

  if new_role is null or new_role not in ('student', 'lecturer', 'admin') then
    raise exception 'Choose a valid account role.';
  end if;

  if target_user_id = auth.uid() then
    raise exception 'You cannot change your own role.';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapmark-admin-role-change'));

  select p.role into current_role
  from public.profiles p
  where p.id = target_user_id
  for update;

  if current_role is null then
    raise exception 'That user account could not be found.';
  end if;

  if current_role = 'admin' and new_role <> 'admin' then
    select count(*) into administrator_count
    from public.profiles p
    where p.role = 'admin';
    if administrator_count <= 1 then
      raise exception 'The last administrator account cannot be demoted.';
    end if;
  end if;

  update public.profiles
  set role = new_role
  where id = target_user_id;
end;
$$;

revoke all on function public.admin_set_user_role(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_set_user_role(uuid, text) to authenticated;

drop policy if exists "Admins can view all courses" on public.courses;
create policy "Admins can view all courses"
  on public.courses for select to authenticated
  using (public.current_user_has_role('admin'));

drop policy if exists "Admins can create courses" on public.courses;
create policy "Admins can create courses"
  on public.courses for insert to authenticated
  with check (
    public.current_user_has_role('admin')
    and exists (
      select 1 from public.profiles lecturer
      where lecturer.id = courses.lecturer_id and lecturer.role = 'lecturer'
    )
  );

grant update on public.courses to authenticated;

drop policy if exists "Admins can update courses" on public.courses;
create policy "Admins can update courses"
  on public.courses for update to authenticated
  using (public.current_user_has_role('admin'))
  with check (
    public.current_user_has_role('admin')
    and exists (
      select 1 from public.profiles lecturer
      where lecturer.id = courses.lecturer_id and lecturer.role = 'lecturer'
    )
  );

grant select, insert, delete on public.course_enrollments to authenticated;

drop policy if exists "Admins can manage enrollments" on public.course_enrollments;
create policy "Admins can manage enrollments"
  on public.course_enrollments for all to authenticated
  using (public.current_user_has_role('admin'))
  with check (
    public.current_user_has_role('admin')
    and exists (
      select 1 from public.profiles student
      where student.id = course_enrollments.student_id and student.role = 'student'
    )
  );

drop policy if exists "Lecturers can view their course enrollments" on public.course_enrollments;
create policy "Lecturers can view their course enrollments"
  on public.course_enrollments for select to authenticated
  using (
    exists (
      select 1 from public.courses c
      where c.id = course_enrollments.course_id and c.lecturer_id = (select auth.uid())
    )
  );

drop policy if exists "Admins can view all sessions" on public.sessions;
create policy "Admins can view all sessions"
  on public.sessions for select to authenticated
  using (public.current_user_has_role('admin'));

drop policy if exists "Lecturers can view all attendance in their courses" on public.attendance;
create policy "Lecturers can view all attendance in their courses"
  on public.attendance for select to authenticated
  using (
    exists (
      select 1
      from public.sessions s
      join public.courses c on c.id = s.course_id
      where s.id = attendance.session_id and c.lecturer_id = (select auth.uid())
    )
  );

create or replace function public.get_lecturer_attendance_report()
returns table (
  course_id uuid,
  course_name text,
  course_code text,
  session_id uuid,
  session_created_at timestamptz,
  session_expires_at timestamptz,
  student_id uuid,
  student_name text,
  student_email text,
  marked_at timestamptz,
  attended_sessions bigint,
  total_sessions bigint
)
language sql
security definer
set search_path = ''
as $$
  with lecturer_courses as (
    select c.id, c.name, c.code
    from public.courses c
    where c.lecturer_id = auth.uid()
      and exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.role = 'lecturer'
      )
  ),
  completed_sessions as (
    select s.id, s.course_id, s.created_at, s.expires_at
    from public.sessions s
    join lecturer_courses c on c.id = s.course_id
    where s.expires_at <= now()
  ),
  course_session_counts as (
    select cs.course_id, count(*)::bigint as total_sessions
    from completed_sessions cs
    group by cs.course_id
  ),
  student_totals as (
    select e.course_id,
      e.student_id,
      count(cs.id)::bigint as total_sessions,
      count(a.id)::bigint as attended_sessions
    from public.course_enrollments e
    join lecturer_courses c on c.id = e.course_id
    left join completed_sessions cs on cs.course_id = e.course_id
    left join public.attendance a
      on a.session_id = cs.id and a.student_id = e.student_id
    group by e.course_id, e.student_id
  )
  select c.id, c.name, c.code,
    cs.id, cs.created_at, cs.expires_at,
    st.id, st.full_name, st.email,
    a.marked_at,
    coalesce(totals.attended_sessions, 0),
    coalesce(totals.total_sessions, session_counts.total_sessions, 0)
  from lecturer_courses c
  left join course_session_counts session_counts on session_counts.course_id = c.id
  left join student_totals totals on totals.course_id = c.id
  left join public.profiles st on st.id = totals.student_id
  left join completed_sessions cs on cs.course_id = c.id
  left join public.attendance a
    on a.session_id = cs.id and a.student_id = totals.student_id
  order by c.name, cs.created_at desc nulls last, st.full_name;
$$;

revoke all on function public.get_lecturer_attendance_report() from public, anon, authenticated;
grant execute on function public.get_lecturer_attendance_report() to authenticated;
