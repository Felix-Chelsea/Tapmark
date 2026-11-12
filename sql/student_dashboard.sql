-- Run after auth.sql and lecturer_dashboard.sql.
-- Enroll students through a trusted administrator process; students cannot
-- enroll themselves or change course membership from the browser.
create table if not exists public.course_enrollments (
  course_id uuid not null references public.courses (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  enrolled_at timestamptz not null default now(),
  primary key (course_id, student_id)
);

create index if not exists course_enrollments_student_idx
  on public.course_enrollments (student_id, course_id);

alter table public.course_enrollments enable row level security;
revoke all on public.course_enrollments from public, anon, authenticated;
grant select on public.course_enrollments to authenticated;

drop policy if exists "Students can view their own course enrollments" on public.course_enrollments;
create policy "Students can view their own course enrollments"
  on public.course_enrollments for select to authenticated
  using (student_id = (select auth.uid()));

create or replace function public.mark_attendance(token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_session_id uuid;
  active_course_id uuid;
  marked_attendance_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in is required to mark attendance.';
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'student'
  ) then
    raise exception 'Only student accounts can mark attendance.';
  end if;

  select s.id, s.course_id
    into active_session_id, active_course_id
  from public.sessions s
  where s.qr_token = token and s.expires_at > now();

  if active_session_id is null then
    raise exception 'This attendance code is invalid or has expired.';
  end if;

  if not exists (
    select 1 from public.course_enrollments e
    where e.course_id = active_course_id and e.student_id = auth.uid()
  ) then
    raise exception 'You are not enrolled in this course.';
  end if;

  insert into public.attendance (session_id, student_id)
  values (active_session_id, auth.uid())
  on conflict (session_id, student_id) do nothing
  returning id into marked_attendance_id;

  if marked_attendance_id is null then
    select a.id into marked_attendance_id
    from public.attendance a
    where a.session_id = active_session_id and a.student_id = auth.uid();
  end if;

  return marked_attendance_id;
end;
$$;

revoke all on function public.mark_attendance(text) from public, anon, authenticated;
grant execute on function public.mark_attendance(text) to authenticated;

create or replace function public.get_my_attendance_history()
returns table (
  id uuid,
  session_id uuid,
  course_id uuid,
  course_name text,
  course_code text,
  marked_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select a.id, a.session_id, c.id, c.name, c.code, a.marked_at
  from public.attendance a
  join public.sessions s on s.id = a.session_id
  join public.courses c on c.id = s.course_id
  where a.student_id = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'student'
    )
  order by a.marked_at desc;
$$;

revoke all on function public.get_my_attendance_history() from public, anon, authenticated;
grant execute on function public.get_my_attendance_history() to authenticated;

drop policy if exists "Students can view enrolled courses" on public.courses;
create policy "Students can view enrolled courses"
  on public.courses for select to authenticated
  using (
    exists (
      select 1 from public.course_enrollments e
      where e.course_id = courses.id and e.student_id = (select auth.uid())
    )
  );

drop policy if exists "Enrolled students can view completed or attended sessions" on public.sessions;
create policy "Enrolled students can view completed or attended sessions"
  on public.sessions for select to authenticated
  using (
    exists (
      select 1 from public.course_enrollments e
      where e.course_id = sessions.course_id and e.student_id = (select auth.uid())
    )
    and sessions.expires_at <= now()
  );
