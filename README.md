# School Feedback and Suggestion System

Students and teachers submit feedback, suggestions, and concerns, anonymously or with their name.
Staff review submissions, update their status, and watch progress through simple reports.

Built with Node.js, Express, EJS, and MySQL.

## Run it

1. **Start MySQL** (XAMPP: start *MySQL* in the control panel).
2. **Import the database.** In phpMyAdmin create a database named `school_feedback_system`,
   then import `database/school_feedback_system.sql`.
3. **Check `.env`.** `.env.example` shows every setting. Set a long random `SESSION_SECRET`.
4. **Install and start:**

   ```bash
   npm install
   npm run set-password -- admin@school.edu "your-new-password-here"
   npm run dev      # restarts on every change
   # or
   npm start
   ```

   The SQL dump contains an empty feedback database and a placeholder administrator account;
   it excludes real feedback and staff records. Set a new administrator password before logging
   in. The dump seeds categories, departments, and statuses.

5. Open <http://localhost:3000>.

## Pages

| Page | Address | Who |
|---|---|---|
| Home | `/` | Everyone |
| Submit feedback | `/feedback/submit` | Everyone |
| Confirmation (reference code) | `/feedback/submitted` | After submitting |
| Track a submission | `/feedback/track` | Everyone |
| Staff login | `/auth/login` | Staff |
| Dashboard | `/staff/dashboard` | Any logged-in account |
| All feedback (assign departments) | `/feedback/admin` | Admin |
| Department inbox | `/feedback/department-inbox` | Administrative staff, department heads, guidance staff, IT staff |
| School overview (read-only) | `/feedback/management` | Institutional management |
| Feedback details | `/feedback/view/:id` | Admin, management (read-only), and the assigned department |
| Reports | `/staff/reports` | Admin, management, department staff (their own department) |
| My submissions | `/feedback/my-submissions` | Any logged-in account |
| Staff accounts | `/auth/create-staff` | Admin |

## Who can do what

| Role | Sees | Can change |
|---|---|---|
| `admin` | All feedback | Status, department assignment, staff accounts |
| `administrative_staff`, `department_head`, `guidance_staff`, `it_staff` | Feedback assigned to their department | Status and notes on those items |
| `institutional_management` | All feedback and reports | Nothing (read-only) |
| `faculty` | Their own submissions | Nothing |

New feedback starts as **Pending** and unassigned. An admin assigns a department, and that
department's staff move it through **Under Review**, **In Progress**, and **Resolved**.

## Good to know

- **Anonymous feedback** stores no name, no email, and is not linked to any account.
  The reference code is the only way to follow it.
- **Reference codes** display as `9B5F-485A-7549-2EE0`. Dashes, spaces, and lowercase all work when tracking.
- **Notes** that staff add are visible to the submitter on the tracking page.
- **Forgot a staff password?** Run
  `npm run set-password -- admin@school.edu "a-new-long-password"`.
- Passwords must be at least 12 characters. After 5 wrong logins an account/device is paused for 15 minutes.

## Project layout

```
app.js              Starts the server, wires everything together
config/db.js        MySQL connection pool and transaction helper
middleware/auth.js  Login checks, role checks, form protection
lib/                Shared helpers, query builders, icons, constants
routes/             feedback.js (public + staff), auth.js, staff.js (dashboard, reports)
views/              EJS pages; views/partials holds shared pieces
public/             css/style.css and js/app.js
database/           SQL export
scripts/            set-password.js
```
