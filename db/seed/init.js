const adminDb = db.getSiblingDB("admin");
if (!adminDb.getUser("animo_app")) {
  adminDb.createUser({
    user: "animo_app",
    pwd: "local-dev-secret",
    roles: [{ role: "readWrite", db: "animoassign" }],
  });
}

const appDb = db.getSiblingDB("animoassign");

appDb.assignments.drop();
appDb.assignments.insertMany([
  { title: "Prototype architecture", status: "in_progress" },
  { title: "Implement backend", status: "todo" },
  { title: "Analytics aggregation", status: "done" }
]);