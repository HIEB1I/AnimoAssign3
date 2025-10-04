// Create the application user and seed demo assignments (local development only).
const adminDb = db.getSiblingDB("admin");

const userSpec = {
  pwd: "localdev",
  roles: [{ role: "readWrite", db: "animoassign" }],
};

const existingUser = adminDb.getUser("animo_app");
if (!existingUser) {
  adminDb.createUser({
    user: "animo_app",
    ...userSpec,
  });
  print("✅ Created MongoDB user animo_app");
} else {
  adminDb.updateUser("animo_app", userSpec);
  print("ℹ️  Refreshed password and roles for MongoDB user animo_app");
}

const appDb = db.getSiblingDB("animoassign");

appDb.assignments.drop();
appDb.assignments.insertMany([
  { title: "Prototype architecture", status: "in_progress" },
  { title: "Implement backend", status: "todo" },
  { title: "Analytics aggregation", status: "done" },
]);
