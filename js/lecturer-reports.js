import { guardPage, setupLogout } from "./auth.js";
import { supabase } from "./supabase.js";

const appRoot = document.body.dataset.appRoot || "../";
const reportNotice = document.querySelector("#report-notice");
const reportsList = document.querySelector("#reports-list");
const exportButton = document.querySelector("#export-csv");
let reportRows = [];

function showNotice(message) {
  reportNotice.textContent = message;
  reportNotice.dataset.kind = message ? "error" : "";
}

function formatDate(value, options = { dateStyle: "medium", timeStyle: "short" }) {
  return value
    ? new Intl.DateTimeFormat(undefined, options).format(new Date(value))
    : "—";
}

function makeCell(tag, text) {
  const cell = document.createElement(tag);
  cell.textContent = text;
  return cell;
}

function groupReport(rows) {
  const courses = new Map();
  for (const row of rows) {
    let course = courses.get(row.course_id);
    if (!course) {
      course = {
        id: row.course_id,
        name: row.course_name,
        code: row.course_code,
        totalSessions: Number(row.total_sessions || 0),
        students: new Map(),
        sessions: new Map(),
      };
      courses.set(row.course_id, course);
    }

    if (row.student_id && !course.students.has(row.student_id)) {
      course.students.set(row.student_id, {
        id: row.student_id,
        name: row.student_name || "Student",
        email: row.student_email || "",
        attended: Number(row.attended_sessions || 0),
        total: Number(row.total_sessions || 0),
      });
    }

    if (!row.session_id) continue;
    let session = course.sessions.get(row.session_id);
    if (!session) {
      session = {
        id: row.session_id,
        createdAt: row.session_created_at,
        expiresAt: row.session_expires_at,
        attendance: [],
      };
      course.sessions.set(row.session_id, session);
    }
    if (row.student_id) {
      session.attendance.push({
        name: row.student_name || "Student",
        email: row.student_email || "",
        markedAt: row.marked_at,
      });
    }
  }
  return [...courses.values()];
}

function renderReports(rows) {
  reportsList.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No courses or attendance data is available yet.";
    reportsList.append(empty);
    return;
  }

  for (const course of groupReport(rows)) {
    const card = document.createElement("article");
    card.className = "report-course-card";
    const header = document.createElement("div");
    header.className = "report-course-heading";
    const title = document.createElement("div");
    const name = document.createElement("h2");
    const code = document.createElement("p");
    const sessionCount = document.createElement("span");
    name.textContent = course.name;
    code.textContent = course.code;
    sessionCount.className = "report-session-count";
    sessionCount.textContent = `${course.totalSessions} completed ${course.totalSessions === 1 ? "session" : "sessions"}`;
    title.append(name, code);
    header.append(title, sessionCount);
    card.append(header);

    const studentsHeading = document.createElement("h3");
    studentsHeading.className = "report-subheading";
    studentsHeading.textContent = "Student attendance";
    card.append(studentsHeading);
    const studentTableWrap = document.createElement("div");
    studentTableWrap.className = "admin-table-wrap report-table-wrap";
    const studentTable = document.createElement("table");
    studentTable.className = "admin-table report-table";
    studentTable.innerHTML = "<thead><tr><th scope=\"col\">Student</th><th scope=\"col\">Sessions attended</th><th scope=\"col\">Attendance</th></tr></thead>";
    const studentBody = document.createElement("tbody");
    for (const student of course.students.values()) {
      const percentage = student.total ? Math.round((student.attended / student.total) * 100) : 0;
      const row = document.createElement("tr");
      if (student.total > 0 && student.attended / student.total < 0.75) row.className = "low-attendance";
      const identity = document.createElement("td");
      identity.textContent = student.email ? `${student.name} (${student.email})` : student.name;
      row.append(
        identity,
        makeCell("td", `${student.attended} / ${student.total}`),
        makeCell("td", student.total ? `${percentage}%` : "No completed sessions"),
      );
      studentBody.append(row);
    }
    studentTable.append(studentBody);
    studentTableWrap.append(studentTable);
    card.append(studentTableWrap);

    const sessionsHeading = document.createElement("h3");
    sessionsHeading.className = "report-subheading";
    sessionsHeading.textContent = "Session attendance";
    card.append(sessionsHeading);
    if (course.sessions.size === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No sessions have been completed for this course.";
      card.append(empty);
    } else {
      const sessions = [...course.sessions.values()]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      for (const session of sessions) {
        const sessionSection = document.createElement("section");
        sessionSection.className = "report-session";
        const sessionTitle = document.createElement("h4");
        sessionTitle.textContent = formatDate(session.createdAt);
        const checkedIn = session.attendance.filter((student) => student.markedAt);
        const roster = document.createElement("p");
        roster.className = "report-session-roster";
        roster.textContent = checkedIn.length
          ? checkedIn.map((student) => student.email ? `${student.name} (${student.email})` : student.name).join(", ")
          : "No students checked in.";
        const summary = document.createElement("span");
        summary.className = "report-session-summary";
        summary.textContent = `${checkedIn.length} of ${course.students.size} students`;
        sessionSection.append(sessionTitle, summary, roster);
        card.append(sessionSection);
      }
    }
    reportsList.append(card);
  }
}

function csvValue(value) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv() {
  if (!reportRows.length) return;
  const headers = [
    "Course",
    "Course code",
    "Session ID",
    "Session started",
    "Student",
    "Student email",
    "Attendance marked at",
    "Attended sessions",
    "Completed sessions",
    "Attendance percentage",
    "Below 75%",
  ];
  const lines = [headers.map(csvValue).join(",")];
  for (const row of reportRows) {
    const total = Number(row.total_sessions || 0);
    const attended = Number(row.attended_sessions || 0);
    const percentage = total ? Math.round((attended / total) * 100) : 0;
    lines.push([
      row.course_name,
      row.course_code,
      row.session_id || "",
      row.session_created_at ? new Date(row.session_created_at).toISOString() : "",
      row.student_name,
      row.student_email,
      row.marked_at ? new Date(row.marked_at).toISOString() : "",
      attended,
      total,
      total ? `${percentage}%` : "",
      total > 0 && attended / total < 0.75 ? "Yes" : "No",
    ].map(csvValue).join(","));
  }

  const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `tapmark-attendance-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function initialize() {
  setupLogout(appRoot);
  if (!await guardPage("lecturer", appRoot)) return;
  exportButton.addEventListener("click", exportCsv);

  const { data, error } = await supabase.rpc("get_lecturer_attendance_report");
  if (error) {
    showNotice("We couldn't load attendance reports. Check the database setup and refresh the page.");
    reportsList.replaceChildren();
    return;
  }
  reportRows = data || [];
  renderReports(reportRows);
  exportButton.disabled = reportRows.length === 0;
}

void initialize();
