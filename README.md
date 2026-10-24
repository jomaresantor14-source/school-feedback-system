# School Feedback and Suggestion System

A web-based platform for students, teachers, and school staff to submit feedback, concerns, and suggestions in one place. Submitters can send messages anonymously or with their names, while authorized staff review, assign, and resolve each case using a unique reference code.

This project was developed as a midterm campus system application using Node.js, Express, EJS, and MySQL.

## Project Description

Schools often collect feedback through informal channels, which makes it hard to track issues and communicate updates back to the people who raised them. This system centralizes submissions and gives each report a reference code so it can be followed from submission to resolution.

Target users:
- Students and teachers
- Administrative staff
- Department heads
- Guidance and IT staff
- Institutional management

## Team Members

| Name | Primary Responsibility |
|---|---|
| Santor Jomare M. | Backend, routes, and business logic |
| Laurza, Eddbert R. | Frontend pages, forms, and UI |
| Imperial, Benedic | Database setup, authentication, and testing |

Team name: ReneeGan  
Course/Section: BSIT - 3E

## Tech Stack

- Node.js
- Express.js
- EJS templates
- MySQL (XAMPP / phpMyAdmin)
- express-session
- bcrypt

## Features

- Feedback and suggestion submission with optional anonymity
- Unique reference code for tracking submissions
- Role-based access for admin and staff users
- Department inbox and assignment workflow
- Status updates and history tracking
- Staff dashboard and reporting pages
- Complaint and suggestion categorization
- Secure login with session-based authentication

## Prerequisites

Before running the project, make sure you have:

- [Node.js](https://nodejs.org/) installed
- MySQL running locally (for example through XAMPP)
- npm package manager

## Installation and Setup

1. Clone the repository:

```bash
git clone <repository-url>
cd school-feedback-system
```

2. Install dependencies:

```bash
npm install
```

If you are using Windows PowerShell and scripts are blocked, use:

```bash
npm.cmd install
```

3. Create the environment file:

```bash
copy .env.example .env
```

4. Update the values in `.env` based on your local MySQL setup.

## Configuration

Copy `.env.example` to `.env` and set the values:

```env
PORT=3000
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=school_feedback_system
SESSION_SECRET=replace_this_with_a_long_random_secret
```

Generate a secure session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The `.env` file contains sensitive values and should not be committed to the repository.

## Database Setup

1. Start MySQL from XAMPP.
2. Open phpMyAdmin at `http://localhost/phpmyadmin`.
3. Create a database named `school_feedback_system`.
4. Import the SQL file from `database/school_feedback_system.sql`.

The database includes tables such as:
- `users`
- `departments`
- `categories`
- `statuses`
- `feedback`
- `feedback_history`
- `feedback_assignment_history`

## Running the Application

Start the app with:

```bash
node app.js
```

Or run it in development mode with auto-restart:

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

The console should display a message similar to:

```text
Connected to MySQL database!
```

## Main Pages

| Page | Route |
|---|---|
| Home | `/` |
| Submit feedback | `/feedback/submit` |
| Track submission | `/feedback/track` |
| Staff login | `/auth/login` |
| Staff dashboard | `/staff/dashboard` |

## Test Accounts

These sample accounts are intended for local testing only.

Set a known password for each account once from the project folder:

```bash
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


Use these accounts only for local testing. Replace or remove them before deploying to a real environment.


## Project Structure

```text
app.js                Starts the server and loads the main app configuration
config/               Database connection and configuration files
middleware/           Authentication, authorization, and request checks
lib/                  Shared helpers and utility logic
routes/
  auth.js              Login, logout, and staff account creation routes
  feedback.js          Feedback submission, tracking, review, and assignment routes
  staff.js             Dashboard and reporting routes
views/                EJS templates for pages and partials
public/               Static assets such as CSS and JavaScript
database/             SQL export of the database schema/data
scripts/              Utility scripts such as password reset
```


## Known Limitations


- Session data is stored in memory, so all users are logged out when the server restarts.
- There is no dedicated change-password page; password updates are handled with the script in `scripts/`.
- Staff accounts can be created in the application but not edited or deleted from the UI.
- No email notifications are currently implemented; submitters must use the reference code to track updates.
- Anonymous submitters who lose their reference code cannot recover the submission.
- File attachments are not supported.
- Login lockout tracking is kept in memory and resets after server restart.
- The app uses plain HTTP in development; production deployment should use HTTPS.
- There is no automated test suite included in the repository.


## AI Assistance Disclosure


This project was developed with the assistance of ChatGPT, Claude (Anthropic), and Copilot. The AI was used to help refactor the application, design page templates and styling, test scenarios against a local database copy, and assist with documentation.


The team reviewed the final implementation and remains responsible for understanding and maintaining the codebase.


## License


This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

