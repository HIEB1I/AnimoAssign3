// Creates dev DB & user if missing
db = db.getSiblingDB(process.env.DEV_DB_NAME || 'animoassign_dev');
if (!db.getUser(process.env.DEV_APP_USER || 'animo_app')) {
  db.createUser({
    user: process.env.DEV_APP_USER || 'animo_app',
    pwd:  process.env.DEV_APP_PASS || 'devpass',
    roles: [{ role: 'readWrite', db: db.getName() }],
  });
}
db.records.insertOne({ title: 'Hello Dev', content: 'Seed doc', createdAt: new Date() });
