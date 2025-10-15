db = db.getSiblingDB('animoassign_stg');
db.createUser({
  user: 'animo_app',
  pwd:  'StagingDLSU',
  roles: [{ role: 'readWrite', db: 'animoassign_stg' }],
});