import { guardPage, setupLogout } from "./auth.js";
import { supabase } from "./supabase.js";

const appRoot = document.body.dataset.appRoot || "../";
const notice = document.querySelector("#admin-notice");
const usersList = document.querySelector("#users-list");
const coursesList = document.querySelector("#courses-list");
const enrollmentsList = document.querySelector("#enrollments-list");
const lecturerSelect = document.querySelector("#admin-course-lecturer");
const enrollmentCourseSelect = document.querySelector("#enrollment-course");
const enrollmentStudentSelect = document.querySelector("#enrollment-student");
const courseMessage = document.querySelector("#course-message");
const enrollmentMessage = document.querySelector("#enrollment-message");

let users = [];
let courses = [];
let enrollments = [];
let currentUserId = null;

function showNotice(message) {
  notice.textContent = message;
  notice.dataset.kind = message ? "error" : "";
}

function showMessage(element, message, kind = "error") {
  element.textContent = message;
  element.dataset.kind = message ? kind : "";
}

function setRowsEmpty(body, columns, message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.className = "empty-state";
  cell.colSpan = columns;
  cell.textContent = message;
  row.append(cell);
  body.replaceChildren(row);
}

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function populateSelect(select, items, placeholder, labelFor) {
  const placeholderOption = createOption("", placeholder);
  placeholderOption.disabled = true;
  placeholderOption.selected = true;
  select.replaceChildren(placeholderOption);
  for (const item of items) {
    select.append(createOption(item.id, labelFor(item)));
  }
  select.disabled = items.length === 0;
}

function renderUsers() {
  if (!users.length) {
    setRowsEmpty(usersList, 4, "No user accounts found.");
    return;
  }

  usersList.replaceChildren();
  for (const user of users) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const emailCell = document.createElement("td");
    const roleCell = document.createElement("td");
    const actionCell = document.createElement("td");
    const select = document.createElement("select");
    const save = document.createElement("button");

    nameCell.textContent = user.full_name || "Unnamed user";
    emailCell.textContent = user.email || "—";
    select.setAttribute("aria-label", `Role for ${user.full_name || user.email || "user"}`);
    for (const role of ["student", "lecturer", "admin"]) {
      select.append(createOption(role, role[0].toUpperCase() + role.slice(1)));
    }
    select.value = user.role;
    select.disabled = user.id === currentUserId;
    save.className = "button button-small table-action";
    save.type = "button";
    save.textContent = user.id === currentUserId ? "Current account" : "Save role";
    save.disabled = user.id === currentUserId;
    save.addEventListener("click", async () => {
      save.disabled = true;
      save.textContent = "Saving…";
      try {
        const { error } = await supabase.rpc("admin_set_user_role", {
          target_user_id: user.id,
          new_role: select.value,
        });
        if (error) throw error;
        user.role = select.value;
        showMessage(notice, "User role updated.", "success");
        renderUsers();
        renderCourses();
        updateAvailableStudents();
      } catch {
        showNotice("We couldn't update that role. The last administrator and your own role are protected.");
        save.disabled = false;
        save.textContent = "Save role";
      }
    });
    roleCell.append(select);
    actionCell.append(save);
    row.append(nameCell, emailCell, roleCell, actionCell);
    usersList.append(row);
  }
}

function renderCourses() {
  if (!courses.length) {
    setRowsEmpty(coursesList, 5, "No courses have been created yet.");
  } else {
    coursesList.replaceChildren();
    for (const course of courses) {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      const codeCell = document.createElement("td");
      const lecturerCell = document.createElement("td");
      const countCell = document.createElement("td");
      const actionCell = document.createElement("td");
      const nameInput = document.createElement("input");
      const codeInput = document.createElement("input");
      const lecturerInput = document.createElement("select");
      const save = document.createElement("button");
      nameInput.value = course.name;
      nameInput.maxLength = 120;
      nameInput.setAttribute("aria-label", `Course name for ${course.code}`);
      codeInput.value = course.code;
      codeInput.maxLength = 24;
      codeInput.setAttribute("aria-label", `Course code for ${course.name}`);
      for (const user of users.filter((item) => item.role === "lecturer")) {
        lecturerInput.append(createOption(
          user.id,
          user.full_name ? `${user.full_name} (${user.email})` : user.email || "Lecturer",
        ));
      }
      lecturerInput.value = course.lecturer_id;
      lecturerInput.setAttribute("aria-label", `Lecturer for ${course.code}`);
      countCell.textContent = String(course.enrollment_count || 0);
      save.className = "button button-small table-action";
      save.type = "button";
      save.textContent = "Save";
      save.addEventListener("click", async () => {
        save.disabled = true;
        save.textContent = "Saving…";
        try {
          const { error } = await supabase.from("courses").update({
            name: nameInput.value.trim(),
            code: codeInput.value.trim().toUpperCase(),
            lecturer_id: lecturerInput.value,
          }).eq("id", course.id);
          if (error) throw error;
          showMessage(notice, "Course updated.", "success");
          await loadCourses();
          await loadEnrollments();
        } catch {
          showNotice("We couldn't update that course. Check its name, code, and lecturer.");
          save.disabled = false;
          save.textContent = "Save";
        }
      });
      nameCell.append(nameInput);
      codeCell.append(codeInput);
      lecturerCell.append(lecturerInput);
      actionCell.append(save);
      row.append(nameCell, codeCell, lecturerCell, countCell, actionCell);
      coursesList.append(row);
    }
  }

  populateSelect(lecturerSelect, users.filter((user) => user.role === "lecturer"), "Choose a lecturer", (user) =>
    user.full_name ? `${user.full_name} (${user.email})` : user.email || "Lecturer",
  );
  populateSelect(enrollmentCourseSelect, courses, "Choose a course", (course) => `${course.code} — ${course.name}`);
}

function renderEnrollments() {
  if (!enrollments.length) {
    setRowsEmpty(enrollmentsList, 4, "No enrollments yet.");
    updateAvailableStudents();
    return;
  }
  enrollmentsList.replaceChildren();
  for (const enrollment of enrollments) {
    const row = document.createElement("tr");
    const courseCell = document.createElement("td");
    const studentCell = document.createElement("td");
    const dateCell = document.createElement("td");
    const actionCell = document.createElement("td");
    const remove = document.createElement("button");

    courseCell.textContent = `${enrollment.course.code} — ${enrollment.course.name}`;
    studentCell.textContent = enrollment.student.full_name || enrollment.student.email || "Student";
    dateCell.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" })
      .format(new Date(enrollment.enrolled_at));
    remove.className = "button button-small button-danger table-action";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Remove ${enrollment.student.full_name || enrollment.student.email} from ${enrollment.course.name}?`)) return;
      remove.disabled = true;
      try {
        const { error } = await supabase.from("course_enrollments").delete()
          .eq("course_id", enrollment.course_id)
          .eq("student_id", enrollment.student_id);
        if (error) throw error;
        showMessage(enrollmentMessage, "Student removed from the course.", "success");
        await loadEnrollments();
      } catch {
        showMessage(enrollmentMessage, "We couldn't remove that enrollment. Please try again.");
        remove.disabled = false;
      }
    });
    actionCell.append(remove);
    row.append(courseCell, studentCell, dateCell, actionCell);
    enrollmentsList.append(row);
  }
  updateAvailableStudents();
}

function updateAvailableStudents() {
  const courseId = enrollmentCourseSelect.value;
  const enrolledIds = new Set(
    enrollments.filter((item) => item.course_id === courseId).map((item) => item.student_id),
  );
  const available = users.filter((user) => user.role === "student" && !enrolledIds.has(user.id));
  populateSelect(enrollmentStudentSelect, available, "Choose a student", (user) =>
    user.full_name ? `${user.full_name} (${user.email})` : user.email || "Student",
  );
}

async function loadUsers() {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, created_at")
    .order("full_name");
  if (error) throw error;
  users = data;
  renderUsers();
  renderCourses();
  updateAvailableStudents();
}

async function loadCourses() {
  const { data: courseData, error } = await supabase
    .from("courses")
    .select("id, name, code, lecturer_id, created_at")
    .order("name");
  if (error) throw error;
  const { data: enrollmentsData, error: enrollmentError } = await supabase
    .from("course_enrollments")
    .select("course_id");
  if (enrollmentError) throw enrollmentError;
  const counts = new Map();
  for (const item of enrollmentsData) counts.set(item.course_id, (counts.get(item.course_id) || 0) + 1);
  const usersById = new Map(users.map((user) => [user.id, user]));
  courses = courseData.map((course) => ({
    ...course,
    lecturer: usersById.get(course.lecturer_id),
    enrollment_count: counts.get(course.id) || 0,
  }));
  renderCourses();
}

async function loadEnrollments() {
  const { data, error } = await supabase
    .from("course_enrollments")
    .select("course_id, student_id, enrolled_at");
  if (error) throw error;
  const coursesById = new Map(courses.map((course) => [course.id, course]));
  const usersById = new Map(users.map((user) => [user.id, user]));
  enrollments = data
    .filter((item) => coursesById.has(item.course_id) && usersById.has(item.student_id))
    .map((item) => ({
      ...item,
      course: coursesById.get(item.course_id),
      student: usersById.get(item.student_id),
    }))
    .sort((a, b) => a.course.name.localeCompare(b.course.name) || a.student.full_name.localeCompare(b.student.full_name));
  renderEnrollments();
}

function setupForms() {
  document.querySelector("#admin-course-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage(courseMessage, "");
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const submit = document.querySelector("#admin-course-submit");
    submit.disabled = true;
    submit.textContent = "Creating…";
    try {
      const { error } = await supabase.from("courses").insert({
        name: form.elements.name.value.trim(),
        code: form.elements.code.value.trim().toUpperCase(),
        lecturer_id: form.elements.lecturer_id.value,
      });
      if (error) throw error;
      form.reset();
      showMessage(courseMessage, "Course created.", "success");
      await loadCourses();
      await loadEnrollments();
    } catch {
      showMessage(courseMessage, "We couldn't create that course. Check the course code and lecturer.");
    } finally {
      submit.disabled = false;
      submit.textContent = "Create course";
    }
  });

  document.querySelector("#enrollment-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage(enrollmentMessage, "");
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const submit = document.querySelector("#enrollment-submit");
    submit.disabled = true;
    submit.textContent = "Enrolling…";
    try {
      const { error } = await supabase.from("course_enrollments").insert({
        course_id: form.elements.course_id.value,
        student_id: form.elements.student_id.value,
      });
      if (error) throw error;
      showMessage(enrollmentMessage, "Student enrolled.", "success");
      await Promise.all([loadCourses(), loadEnrollments()]);
    } catch {
      showMessage(enrollmentMessage, "We couldn't enroll that student. They may already be enrolled.");
    } finally {
      submit.disabled = false;
      submit.textContent = "Enroll student";
    }
  });
}

async function initialize() {
  setupLogout(appRoot);
  if (!await guardPage("admin", appRoot)) return;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    showNotice("We couldn't verify your administrator account. Please sign in again.");
    return;
  }
  currentUserId = data.user.id;

  try {
    await loadUsers();
    await loadCourses();
    await loadEnrollments();
    enrollmentCourseSelect.addEventListener("change", updateAvailableStudents);
    setupForms();
  } catch {
    showNotice("We couldn't load the management data. Check the database setup and refresh the page.");
  }
}

void initialize();
