-- Run after auth.sql. Course, session, and attendance access is enforced by RLS.
create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  lecturer_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  code text not null check (length(trim(code)) between 1 and 24),
  created_at timestamptz not null default now(),
  unique (lecturer_id, code)
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  created_by uuid not null references public.profiles (id),
  qr_token text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
    check (length(qr_token) >= 32),
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

-- A lecturer may end a session early when starting its replacement.
alter table public.sessions drop constraint if exists sessions_check;

create index if not exists sessions_course_created_idx
  on public.sessions (course_id, created_at desc);
create index if not exists sessions_token_expiry_idx
  on public.sessions (qr_token, expires_at);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  marked_at timestamptz not null default now(),
  unique (session_id, student_id)
);

create index if not exists attendance_session_marked_idx
  on public.attendance (session_id, marked_at);

alter table public.courses enable row level security;
alter table public.sessions enable row level security;
alter table public.attendance enable row level security;

revoke all on public.courses, public.sessions, public.attendance from public, anon, authenticated;
grant select, insert on public.courses to authenticated;
grant select on public.sessions to authenticated;
grant select on public.attendance to authenticated;

drop policy if exists "Lecturers can view their courses" on public.courses;
create policy "Lecturers can view their courses"
  on public.courses for select to authenticated
  using (lecturer_id = (select auth.uid()));

drop policy if exists "Lecturers can create their own courses" on public.courses;
create policy "Lecturers can create their own courses"
  on public.courses for insert to authenticated
  with check (
    lecturer_id = (select auth.uid())
    and exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.role = 'lecturer'
    )
  );

drop policy if exists "Lecturers can view sessions for their courses" on public.sessions;
create policy "Lecturers can view sessions for their courses"
  on public.sessions for select to authenticated
  using (
    exists (
      select 1 from public.courses c
      where c.id = sessions.course_id and c.lecturer_id = (select auth.uid())
    )
  );

drop policy if exists "Lecturers can create sessions for their courses" on public.sessions;

drop policy if exists "Lecturers can view attendance for their sessions" on public.attendance;
create policy "Lecturers can view attendance for their sessions"
  on public.attendance for select to authenticated
  using (
    exists (
      select 1
      from public.sessions s
      join public.courses c on c.id = s.course_id
      where s.id = attendance.session_id and c.lecturer_id = (select auth.uid())
    )
  );

drop policy if exists "Students can view their own attendance" on public.attendance;
create policy "Students can view their own attendance"
  on public.attendance for select to authenticated
  using (student_id = (select auth.uid()));

drop policy if exists "Lecturers can view students in their attendance" on public.profiles;
create policy "Lecturers can view students in their attendance"
  on public.profiles for select to authenticated
  using (
    exists (
      select 1
      from public.attendance a
      join public.sessions s on s.id = a.session_id
      join public.courses c on c.id = s.course_id
      where a.student_id = profiles.id and c.lecturer_id = (select auth.uid())
    )
  );

create or replace function public.start_attendance_session(course_id uuid)
returns setof public.sessions
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'lecturer'
  ) then
    raise exception 'A lecturer account is required to start a class session.';
  end if;

  perform 1
  from public.courses c
  where c.id = start_attendance_session.course_id
    and c.lecturer_id = auth.uid()
  for update;

  if not found then
    raise exception 'You do not have access to this course.';
  end if;

  update public.sessions s
  set expires_at = now()
  where s.course_id = start_attendance_session.course_id
    and s.expires_at > now();

  return query
    insert into public.sessions (course_id, created_by)
    values (start_attendance_session.course_id, auth.uid())
    returning *;
end;
$$;

revoke all on function public.start_attendance_session(uuid) from public, anon, authenticated;
grant execute on function public.start_attendance_session(uuid) to authenticated;

create or replace function public.mark_attendance(token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_session_id uuid;
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

  select s.id into active_session_id
  from public.sessions s
  where s.qr_token = token and s.expires_at > now();

  if active_session_id is null then
    raise exception 'This attendance code is invalid or has expired.';
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

-- Supabase Realtime only streams this table after it is added to its publication.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'attendance'
    )
  then
    execute 'alter publication supabase_realtime add table public.attendance';
  end if;
end;
$$;
