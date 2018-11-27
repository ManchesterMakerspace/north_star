// slackKeyField.js ~ Copyright 2018 Manchester Makerspace ~ MIT License
ObjectID = require('mongodb').ObjectID;
var mongo = {
    client: require('mongodb').MongoClient,
    connectAndDo: function(connected, failed){         // url to db and what well call this db in case we want multiple
        mongo.client.connect(process.env.TEST_MONGODB_URI, function onConnect(error, db){
            if(db){connected(db);} // passes database object so databasy things can happen
            else  {failed(error);} // what to do when your reason for existence is a lie
        });
    }
};

var request = require('request');
var slack = {
    dir: [],
    compileDir: function(onFinish){  // recursively pagenates through request untill a member is or isn't found
        var options = {
            url: 'https://slack.com/api/users.list', //' lookupByEmail',
            method: 'GET',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            qs: {'token': process.env.BOT_TOKEN} // , 'email': email}
        };
        request(options, function(error, response, body){
            if(error){console.log(error);}
            else{
                console.log('status code:' + response.statusCode);
                var resBody = JSON.parse(body);
                console.log('Size of directory: ' + resBody.members.length);
                for(var i = 0; i <  resBody.members.length; i++){
                    var member = {
                        email: resBody.members[i].profile.email,
                        fullname: resBody.members[i].profile.real_name_normalized.toLowerCase(),
                        altname: resBody.members[i].profile.display_name_normalized.toLowerCase(),
                        name: resBody.members[i].name,
                        id: resBody.members[i].id,
                        lastname: resBody.members[i].profile.last_name ? resBody.members[i].profile.last_name.toLowerCase() : '',
                        matched: false
                    };
                    slack.dir.push(member);
                }
                onFinish();
            }
        });
    }
};

check = {
    stream: function(cursor, db, stream, onFinish){
        cursor.nextObject(function onDoc(error, record){     // when next document in the stream is ready
            if(error){console.log('on check: ' + error);}
            else if(record){                                      // as long as stream produces records
                stream(record);                              // function for streaming docs into
                check.stream(cursor, db, stream, onFinish);  // recursively move through all members in collection
            } else if(onFinish){onFinish();}
        });
    }
};

var migrate = {
    success: function(name, type){
        migrate.updates++;
        console.log(name + ' updated based on ' + type);
    },
    fail: function(name, email, inGoodStanding){
        migrate.misses++;
        var memberMessage = inGoodStanding ? 'current' : 'expired';
        console.log('failed to find a match for ' + memberMessage + ' member:' + name + ' email: ' + email);
    },
    updates: 0,
    misses: 0,
    updateSlackInfo: function(db){
        check.stream(db.collection('members').find({}), db, function onDoc(doc){ // for every member document
            for(var i = 0; i < slack.dir.length; i++){ // check if there is a slack email that matches email (both.toLowerCase)
                if(slack.dir[i].email){
                    if(slack.dir[i].email.toLowerCase() === doc.email.toLowerCase()){
                        migrate.createSlackUser(db, doc, slack.dir[i]);
                        slack.dir[i].matched = true;
                        // migrate.success(slack.dir[i].fullname, 'email match');
                        return; // no need to go further
                    }
                }
            }
            // check if there is a slack name that matches fullname.toLowerCase
            var fullname = doc.firstname + ' ' + doc.lastname; var altFullname = doc.firstname + doc.lastname;
            var lowerFullname = fullname.toLowerCase(); var lowerAltFullname = altFullname.toLowerCase();
            for(var x = 0; x < slack.dir.length; x++){
                if(slack.dir[x].fullname === lowerFullname || slack.dir[x].fullname === lowerAltFullname){
                    migrate.createSlackUser(db, doc, slack.dir[x]);
                    slack.dir[x].matched = true;
                    // migrate.success(slack.dir[x].fullname, 'fullname match');
                    return;
                }
            }
            var inGoodStanding = true;
            if(new Date().getTime() < new Date(doc.expirationTime).getTime()){ // look by last name if current in membership
                for(var y = 0; y < slack.dir.length; y++){
                    if(slack.dir[y].lastname === doc.lastname.toLowerCase() || slack.dir[y].lastname === lowerFullname){
                        migrate.createSlackUser(db, doc, slack.dir[y]);
                        slack.dir[y].matched = true;
                        // migrate.success(slack.dir[y].fullname, 'lastname match');
                        return;
                    }
                }
            } else {
                inGoodStanding = false;
                for(var b = 0; b < slack.dir.length; b++){
                    if(slack.dir[b].lastname === doc.lastname.toLowerCase()){
                        console.log(fullname + ' potentialy matches with ' + slack.dir[b].email + ' slackid:' + slack.dir[b].id);
                    }
                }
            }
            migrate.fail(fullname, doc.email, inGoodStanding);
        });
    },
    createSlackUser: function(db, memberDoc, slack_user){
        db.collection('slack_users').insertOne({
            _id: new ObjectID(),
            member_id: memberDoc._id,
            slack_email: slack_user.email,
            slack_id: slack_user.id,
            name: slack_user.name
        });
    },
    duplicateEmail: function(db){
        check.stream(db.collection('members').find({}), db, function onDoc(doc){
            db.collection('members').update({email: memberDoc.email}, {$set: {slackEmail: memberDoc.email}});
        });
    },
    printResults: function(db){
        check.stream(db.collection('members').find({slackEmail: {$exists: 1, $nin: ['']}}), db, function onDoc(doc){
            console.log(doc.slackEmail + ':' + doc.firstname + ' ' + doc.lastname);
        }, function(){console.log('done printResults');});
    },
    nonMatches: function(db){
        for(var i=0; i < slack.dir.length; i++){
            if(!slack.dir[i].matched){
                migrate.createSlackUser(db, {_id: null}, slack.dir[i]);
            }
        }
    }
};

slack.compileDir(function whenCopiled(){
    mongo.connectAndDo(function onConnect(db){
        migrate.updateSlackInfo(db);
        setTimeout(function(){
            migrate.nonMatches(db);
            setTimeout(function(){db.close();}, 14000);
        }, 10000);
    }, console.log);
});
