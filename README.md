# Joseph Okeoma · Prototypes

Two browser prototypes, built in October 2026:

- **Wristside** (`/wristside/`): answers questions about a person's own wearable data with layered answers, a smartwatch view, and every number traced to the records behind it. Uses generated sample data for one fictional person. **Study mode** runs a short within-subjects session: six answers shown in three structures (counterbalanced), recording accuracy, time, confidence and trust, with CSV export.
- **Interactive 3D Classroom** (`/classroom/`): a 3D campus for four courses (Geography, Chemistry, Biology, Computer Networks), each with a lecture hall, a lab, a library and a discussion room, opening onto school grounds with a football pitch and a playground. Lecturers put a PDF, slide images, a video or a YouTube link on the board, run live classes with join codes and see where students are. Separate lecturer and student sign-in. A simulated class previews the lecturer's view.

The classroom is a browser re-creation inspired by my 2023 BSc final-year VR classroom project (Federal University Oye-Ekiti, supervised by Mrs. Daramola). The original Unity/Unreal/Blender files were not preserved; everything here is new work.

No build step: plain HTML, CSS and JavaScript. Libraries load from public CDNs (three.js r128, pdf.js 2.16.105, supabase-js 2.45.4).

---

## 1. Put it online with GitHub Pages (about 10 minutes, no coding)

1. Sign in at github.com and click **New repository**. Name it, e.g. `prototypes`. Choose **Public** (GitHub Pages is free for public repositories). Click **Create repository**.
2. On the new repository page, click **uploading an existing file**. Drag in **everything inside this folder** (index.html, README.md, .nojekyll, and the `classroom`, `wristside` and `supabase` folders). Click **Commit changes**.
   - Tip: drag the folders themselves so their structure is kept. If your browser doesn't show `.nojekyll`, the site still works without it.
3. Go to **Settings → Pages**. Under **Build and deployment**, set **Source: Deploy from a branch**, **Branch: main**, folder **/(root)**. Click **Save**.
4. Wait 1–2 minutes and refresh. Your link appears at the top, like `https://YOUR-USERNAME.github.io/prototypes/`.

That link works straight away in **demo mode**: all of Wristside including study mode, and in the classroom "Try it as a student" or "Try it as a lecturer" (PDF, slide and video uploads stay on the viewer's screen), the library, the school grounds and the simulated class.

---

## 2. Optional: turn on live classes (about 20 minutes)

Live classes need a free Supabase project for sign-in, class codes, shared board files and live presence.

1. Create a project at supabase.com (pick a region close to your users).
2. In the dashboard open **SQL Editor → New query**, paste all of `supabase/setup.sql`, and click **Run**.
3. Open **Project Settings → API** (or **Connect**) and copy the **Project URL** and the **anon / publishable key**.
4. On GitHub, open `classroom/config.js`, click the pencil icon, paste the two values, and commit:
   ```js
   window.CLASSROOM_CONFIG = {
     supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
     supabaseAnonKey: 'YOUR-ANON-KEY',
   };
   ```
   The anon key is designed to be public. **Never put the service_role key in this file.**
5. In Supabase **Authentication → URL Configuration**, set **Site URL** to your GitHub Pages link.
6. For quick testing, in **Authentication → Sign In / Providers → Email**, turn off **Confirm email**. (Supabase's built-in email sender has low limits; for a real class, keep confirmation on and add your own SMTP in Authentication settings.)
7. Get your **lecturer invite code**: in the SQL Editor run
   ```sql
   select value from public.app_settings where key = 'lecturer_invite_code';
   ```
   Give this code only to lecturers. On the classroom page, lecturers choose **I'm a lecturer** and enter it when creating their account (or later, under "Activate lecturer access"). Students choose **I'm a student**. To change the code:
   ```sql
   update public.app_settings set value = 'a-new-code' where key = 'lecturer_invite_code';
   ```
8. Test with a second account in another browser (or a private window): start a live class as the lecturer, then join with the code as the student.

What lecturers get: start/end classes, put a PDF, images or a video on the lecture screen (students' boards follow the page and videos play and pause in sync), YouTube links, a shared whiteboard, a class monitor (each student's room and activity, whether the class tab is open, idle time, raised hands), "bring everyone here", and attendance. Students see a notice explaining what the lecturer can see.

---

## Files

```
index.html              landing page linking both prototypes
wristside/index.html    Wristside (self-contained)
classroom/index.html    classroom page and styles
classroom/app.js        3D world, board, library, whiteboard, simulated class, monitor UI
classroom/content.js    course content (slides, notes, models, discussion prompts)
classroom/backend.js    Supabase layer (sign-in, classes, boards, files, presence)
classroom/config.js     your Supabase URL and anon key (empty = demo mode)
supabase/setup.sql      tables, row-level security, storage bucket, realtime
```

## Notes and limits

- Free plans: Supabase free projects pause after a week without activity (restore them from the dashboard). If live classes stop working, check that first; demo mode keeps working regardless.
- PowerPoint files can't be shown in a browser directly: save them as PDF first (File → Save As → PDF). PDFs and images up to 20 MB; videos (MP4 or WebM) up to 50 MB, which is Supabase's free-plan file limit. For longer videos, use a YouTube link.
- Videos start muted (browsers block sound until you interact); press "Turn sound on".
- Security: database tables use row-level security (only lecturers start classes and change boards; students record only their own attendance). The live presence channel uses Supabase Realtime's public channels, so for wider use switch to Realtime Authorization (private channels).
- The library answers by matching the course notes. An AI version would need a small server function holding an API key; never put an API key in these files.
