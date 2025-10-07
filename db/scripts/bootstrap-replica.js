(function () {
  function log(message) {
    print(`[bootstrap] ${message}`);
  }

  function getEnv(name, fallback) {
    var value = (typeof process !== 'undefined' && process.env && process.env[name]) || '';
    if (!value && typeof fallback !== 'undefined') {
      return fallback;
    }
    return value;
  }

  var replicaSet = getEnv('MONGO_REPLICA_SET', 'animoassignRS');
  var primaryNode = getEnv('MONGO_PRIMARY_NODE', 'mongo-primary:27017');
  var secondaryNode = getEnv('MONGO_SECONDARY_NODE', '');
  var appUser = getEnv('APP_MONGODB_USERNAME', '');
  var appPassword = getEnv('APP_MONGODB_PASSWORD', '');

  function replicaAlreadyInitialised() {
    try {
      var status = rs.status();
      if (status.ok === 1) {
        log('Replica set already initialised.');
        return true;
      }
    } catch (error) {
      if (error.code === 94 || error.codeName === 'NotYetInitialized') {
        return false;
      }
      throw error;
    }
    return false;
  }

  function waitForPrimary() {
    var attempts = 0;
    while (true) {
      try {
        var status = rs.status();
        if (status.ok === 1 && status.myState === 1) {
          log('Replica set primary is online.');
          return;
        }
        log('Replica set status: ' + status.myState + ' (waiting for primary)');
      } catch (error) {
        if (error.code !== 94 && error.codeName !== 'NotYetInitialized') {
          throw error;
        }
        log('Replica set not yet initialised; waiting...');
      }
      attempts += 1;
      sleep(Math.min(5000, 500 + attempts * 250));
    }
  }

  function seedDemoData(appDb) {
    try {
      var existingAssignment = appDb.assignments.findOne({});
      if (existingAssignment) {
        log('Assignments collection already populated; skipping seed.');
        return;
      }

      var now = new Date();
      var seedAssignments = [
        { title: 'Prototype architecture', status: 'in_progress', created_at: now },
        { title: 'Implement backend', status: 'todo', created_at: now },
        { title: 'Analytics aggregation', status: 'done', created_at: now }
      ];
      appDb.assignments.insertMany(seedAssignments, { ordered: true });
      log('Seeded demo assignments collection.');
    } catch (seedError) {
      log('Failed to seed demo assignments: ' + seedError.message);
    }
  }


  if (!replicaAlreadyInitialised()) {
    log('Initialising replica set ' + replicaSet + ' with primary ' + primaryNode + (secondaryNode ? ' and secondary ' + secondaryNode : ''));
    var config = {
      _id: replicaSet,
      members: [
        { _id: 0, host: primaryNode, priority: 2 }
      ]
    };
    if (secondaryNode) {
      config.members.push({ _id: 1, host: secondaryNode, priority: 1 });
    }
    rs.initiate(config);
  } else if (secondaryNode) {
    try {
      var current = rs.status();
      var memberNames = [];
      if (current && current.members) {
        memberNames = current.members.map(function (member) { return member.name; });
      }
      if (memberNames.indexOf(secondaryNode) === -1) {
        log('Adding missing secondary member ' + secondaryNode);
        rs.add({ host: secondaryNode, priority: 1 });
      }
    } catch (statusError) {
      if (statusError.code !== 94 && statusError.codeName !== 'NotYetInitialized') {
        throw statusError;
      }
    }
  }

  waitForPrimary();

  if (appUser && appPassword) {
    var adminDb = db.getSiblingDB('admin');
    var existingUser = adminDb.getUser(appUser);
    if (existingUser) {
      log('Application user ' + appUser + ' already exists.');
    } else {
      log('Creating application user ' + appUser + '.');
      adminDb.createUser({
        user: appUser,
        pwd: appPassword,
        roles: [{ role: 'readWrite', db: 'animoassign' }]
      });
    }
  } else {
    log('Application credentials missing; skipping user creation.');
  }

 try {
    var appDb = db.getSiblingDB('animoassign');
    seedDemoData(appDb);
  } catch (appDbError) {
    log('Unable to obtain application database: ' + appDbError.message);
  }

  log('Replica bootstrap complete.');
})();