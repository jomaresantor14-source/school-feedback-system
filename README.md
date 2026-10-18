# School Feedback and Suggestion System

A web application where students and teachers submit feedback, suggestions, and concerns to the school, anonymously or with their name. Authorized staff review each submission, update its status, and monitor progress through simple reports.

Midterm Project (Campus System, Round 1). Built with Node.js, Express, EJS, and MySQL.

## Project Description

Schools often collect feedback through informal channels, so concerns get lost and the people who raised them never hear back. This system gives everyone one place to send feedback and a **reference code** to follow it from first review to resolution.

**Target users:** students, teachers (submitters) and school staff such as administrators, department heads, guidance, IT, and administrative staff, plus institutional management (reviewers).

**Assigned system:** School Feedback and Suggestion System

## Team Members

| Name | Primary responsibility |
|---|---|
| [Member 1 name] | Backend, routes, business logic |
| Laurza, Eddbert R. | Frontend, pages, forms, UI |
| [Member 3 name] | Database, authentication, testing |

Team name: [Team name] · Course/Section: [Course and section]

## Features

**For everyone (no login needed)**
- **Submit feedback** with a category, subject, and details
- **Anonymous or identified:** anonymous submissions store no name or email and are not linked to any account
- **Reference code** shown after submitting (for example `9B5F-485A-7549-2EE0`)
- **Track a submission** by code: status progress bar, assigned department, and notes from staff

**For staff (login required)**
- **Role-based access:** each role only sees and does what it is allowed to
- **Dashboard** with live counts and a "needs attention" list
- **Search and filters** by text, status, category, and department, with paging
- **Feedback details page** with a full timeline of assignments, status changes, and notes
- **Status management:** Pending, Under Review, In Progress, Resolved, with optional notes
- **Department assignment** (admin) and a department inbox for each office
- **Reports:** total, pending, resolved, resolution rate, common categories, per-department figures
- **Staff account management** (admin): create accounts and see who has access
- **My submissions:** feedback a logged-in user sent under their name

**Security and data handling**
- Passwords hashed with bcrypt, at least 12 characters
- Sessions with logout, session renewal at login, and protected pages
- Form protection (CSRF token) on every staff form
- Login lockout for 15 minutes after 5 failed attempts
- Input checked before saving: required fields, lengths, email format, valid category/status/department, duplicate email
- Output escaped to prevent script injection; database queries use parameters

## Roles and Access

| Role | Sees | Can change |
|---|---|---|
| `admin` | All feedback, reports, staff accounts | Status, department assignment, staff accounts |
| `administrative_staff`, `department_head`, `guidance_staff`, `it_staff` | Feedback assigned to their department | Status and notes on those items |
| `institutional_management` | All feedback and reports | Nothing (read-only) |
| `faculty` | Their own submissions | Nothing |

New feedback starts as **Pending** and unassigned. An admin assigns a department, and that department moves it through the statuses.

## Technologies

- **Node.js** and **Express.js** (server and routes)
- **EJS** (page templates)
- **HTML, CSS, JavaScript** (interface and form behavior)
- **MySQL** with **mysql2** (data storage)
- **express-session** (login sessions)
- **bcrypt** (password hashing)
- **dotenv** (configuration)
- **Git and GitHub** (version control and collaboration)

## Installation and Setup

**Requirements:** [Node.js](https://nodejs.org/) and MySQL (for example XAMPP).

1. **Get the code**
   ```
   git clone <repository-url>
   cd school-feedback-system
   ```
2. **Install packages**
   ```
   npm install
   ```
   On Windows PowerShell, if you see "running scripts is disabled", use `npm.cmd install` instead.
3. **Configure the environment**, copy `.env.example` to `.env` and fill it in (see Configuration below).
4. **Set up the database** (see Database Setup below).

## Configuration

Copy `.env.example` to `.env`:

```
PORT=3000
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=school_feedback_system
SESSION_SECRET=replace_this_with_a_long_random_secret
```

Generate a session secret with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The `.env` file holds secrets and is never committed to the repository.

## Database Setup

1. Start MySQL (XAMPP: click **Start** next to MySQL).
2. Open phpMyAdmin at http://localhost/phpmyadmin.
3. Create a database named `school_feedback_system`.
4. Click **Import** and choose `database/school_feedback_system.sql`.

Tables: `users`, `departments`, `categories`, `statuses`, `feedback`, `feedback_history`, `feedback_assignment_history`.

## How to Run

```
node app.js
```

or, to restart automatically when you change files:

```
npm run dev
```

Then open http://localhost:3000. The console should show `Connected to MySQL database!`.

| Page | Address |
|---|---|
| Home | `/` |
| Submit feedback | `/feedback/submit` |
| Track a submission | `/feedback/track` |
| Staff login | `/auth/login` |
| Dashboard | `/staff/dashboard` |

## User Accounts (for testing)

Set a known password for each account once, from the project folder:

```
node scripts/set-password.js admin@school.edu "Test-Pass-2026"
node scripts/set-password.js joy@school.edu "Test-Pass-2026"
node scripts/set-password.js guidance.staff@school.edu "Test-Pass-2026"
node scripts/set-password.js it@school.edu "Test-Pass-2026"
node scripts/set-password.js academic.head@school.edu "Test-Pass-2026"
node scripts/set-password.js admin.staff@school.edu "Test-Pass-2026"
node scripts/set-password.js management.test@school.edu "Test-Pass-2026"
node scripts/set-password.js rene@school.edu "Test-Pass-2026"
```

| Role | Email | Password |
|---|---|---|
| Administrator | admin@school.edu | Test-Pass-2026 |
| Department Head (Facilities) | joy@school.edu | Test-Pass-2026 |
| Guidance Staff | guidance.staff@school.edu | Test-Pass-2026 |
| IT Staff | it@school.edu | Test-Pass-2026 |
| Department Head (Academic) | academic.head@school.edu | Test-Pass-2026 |
| Administrative Staff | admin.staff@school.edu | Test-Pass-2026 |
| Institutional Management | management.test@school.edu | Test-Pass-2026 |
| Faculty | rene@school.edu | Test-Pass-2026 |

These are test accounts only. Change or remove them before any real use. If you use different accounts or passwords, update this table to match.

## Project Structure

```
app.js              Starts the server and connects everything
config/db.js        MySQL connection pool and transaction helper
middleware/auth.js  Login checks, role checks, form protection, login lockout
lib/                Shared helpers, query builders, icons, constants
routes/
  feedback.js       Submit, track, lists, details, status and assignment
  auth.js           Login, logout, staff account creation
  staff.js          Dashboard and reports
views/              EJS pages (views/partials holds shared pieces)
public/             css/style.css and js/app.js
database/           SQL export of the database
scripts/            set-password.js (reset a staff password)
docs/               Requirements document
```

## Known Limitations

- Sessions are stored in memory, so everyone is logged out when the server restarts.
- There is no change-password page; passwords are changed with `scripts/set-password.js`.
- Staff accounts can be created in the app but not edited or deleted there (use phpMyAdmin).
- No email notifications; submitters must use their reference code to check progress.
- Anonymous submitters who lose their reference code cannot recover their submission.
- No file attachments on submissions.
- The login lockout counter is kept in memory and resets when the server restarts.
- The site runs over plain HTTP in development; use HTTPS in production.
- Testing was done with a scripted run against a test database and by hand; there is no automated test suite in the repository.

## AI Assistance Disclosure

This project was developed with the assistance of **Claude** (Anthropic). Claude was used to:

- rebuild and refactor the application code (routes, validation, access control, and database queries),
- design the page templates and stylesheet,
- run test scenarios against a test copy of the database,
- draft this README and other documentation.

The team reviewed, ran, and tested the result, and is responsible for understanding and defending the code. [Add here any parts the team wrote or changed themselves, and what each member reviewed.]

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
