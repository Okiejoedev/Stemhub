-- Interactive 3D Classroom: Supabase setup
-- Run this once: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- It is safe to run again.

-- ---------- Profiles (one per account) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'User',
  role text not null default 'student' check (role in ('lecturer', 'student')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_lecturer()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'lecturer');
$$;

-- ---------- Classes, boards, attendance ----------
create table if not exists public.classes (
  code text primary key check (code ~ '^[A-Z0-9]{6}$'),
  course text not null,
  live boolean not null default true,
  lecturer_id uuid not null references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists public.class_boards (
  class_code text not null references public.classes(code) on delete cascade,
  room text not null check (room in ('lecture', 'discussion')),
  kind text not null default 'course' check (kind in ('course', 'pdf', 'images', 'image')),
  file_paths text[] not null default '{}',
  name text,
  page int not null default 0,
  pages int not null default 1,
  updated_at timestamptz not null default now(),
  primary key (class_code, room)
);

create table if not exists public.attendance (
  class_code text not null references public.classes(code) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (class_code, student_id)
);

-- ---------- Row Level Security ----------
alter table public.profiles enable row level security;
alter table public.classes enable row level security;
alter table public.class_boards enable row level security;
alter table public.attendance enable row level security;

-- Profiles: signed-in users can read names; each person can change only their own display name.
drop policy if exists "profiles: signed-in read" on public.profiles;
create policy "profiles: signed-in read" on public.profiles for select to authenticated using (true);
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

-- Classes: everyone signed in can see them; only lecturers start them; a lecturer changes only their own.
drop policy if exists "classes: signed-in read" on public.classes;
create policy "classes: signed-in read" on public.classes for select to authenticated using (true);
drop policy if exists "classes: lecturers create" on public.classes;
create policy "classes: lecturers create" on public.classes for insert to authenticated with check (public.is_lecturer() and lecturer_id = auth.uid());
drop policy if exists "classes: lecturer updates own" on public.classes;
create policy "classes: lecturer updates own" on public.classes for update to authenticated using (lecturer_id = auth.uid()) with check (lecturer_id = auth.uid());

-- Boards: everyone signed in can read; only the class's lecturer writes.
drop policy if exists "boards: signed-in read" on public.class_boards;
create policy "boards: signed-in read" on public.class_boards for select to authenticated using (true);
drop policy if exists "boards: lecturer inserts" on public.class_boards;
create policy "boards: lecturer inserts" on public.class_boards for insert to authenticated
  with check (exists (select 1 from public.classes c where c.code = class_code and c.lecturer_id = auth.uid()));
drop policy if exists "boards: lecturer updates" on public.class_boards;
create policy "boards: lecturer updates" on public.class_boards for update to authenticated
  using (exists (select 1 from public.classes c where c.code = class_code and c.lecturer_id = auth.uid()))
  with check (exists (select 1 from public.classes c where c.code = class_code and c.lecturer_id = auth.uid()));

-- Attendance: a student records only themselves, only in a live class; the class's lecturer reads it.
drop policy if exists "attendance: read own or as lecturer" on public.attendance;
create policy "attendance: read own or as lecturer" on public.attendance for select to authenticated
  using (student_id = auth.uid() or exists (select 1 from public.classes c where c.code = class_code and c.lecturer_id = auth.uid()));
drop policy if exists "attendance: student inserts own" on public.attendance;
create policy "attendance: student inserts own" on public.attendance for insert to authenticated
  with check (student_id = auth.uid() and exists (select 1 from public.classes c where c.code = class_code and c.live));
drop policy if exists "attendance: student updates own" on public.attendance;
create policy "attendance: student updates own" on public.attendance for update to authenticated
  using (student_id = auth.uid()) with check (student_id = auth.uid());

-- ---------- File storage for lecture PDFs, slides and whiteboards ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lecture-files', 'lecture-files', false, 20971520, array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "lecture-files: signed-in read" on storage.objects;
create policy "lecture-files: signed-in read" on storage.objects for select to authenticated using (bucket_id = 'lecture-files');
drop policy if exists "lecture-files: lecturers upload" on storage.objects;
create policy "lecture-files: lecturers upload" on storage.objects for insert to authenticated with check (bucket_id = 'lecture-files' and public.is_lecturer());

-- ---------- Live updates for the class list and boards ----------
do $$
begin
  begin alter publication supabase_realtime add table public.classes; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.class_boards; exception when duplicate_object then null; end;
end $$;

-- ---------- Make yourself a lecturer ----------
-- After you create your account on the site, run this with your own email:
-- update public.profiles set role = 'lecturer' where id = (select id from auth.users where email = 'you@example.com');
