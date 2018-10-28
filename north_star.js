// north_star.js ~ Copyright 2018 Manchester Makerspace ~ License MIT
// millisecond conversions
var ONE_DAY = 86400000;
var MEMBER_ACTIVITY_GOAL = 3; // corilates to minimal number of checkin in a month needed to constitute as an actively using the space

var request = require('request');

var slack = {
    send: function(msg){
        var options = {
            uri: process.env.WEBHOOK_MEMBERSHIP,
            method: 'POST',
            json: {'text': msg}
        };
        request(options, function requestResponse(error, response, body){
            if(error){console.log('webhook request error ' + error);}
        });
    }
};

var mongo = {
    client: require('mongodb').MongoClient,
    connectAndDo: function(connected, failed){         // url to db and what well call this db in case we want multiple
        mongo.client.connect(process.env.MONGODB_URI, function onConnect(error, db){
            if(db){connected(db);} // passes database object so databasy things can happen
            else  {failed(error);} // what to do when your reason for existence is a lie
        });
    }
};

var compile = {
    records: [],
    ignoreList: ['Landlords Fob', "Landlord's Fob 2"], // Not a great way to this but its more space efficient than alternitives
    checkins: function(record){                        // copiles records into compile.records
        for(var ignore=0; ignore<compile.ignoreList.length; ignore++){
            if(record.name  === compile.ignoreList[ignore]){return;}     // ignores non member records
        }
        for(var i=0; i<compile.records.length; i++){
            if(compile.records[i].name === record.name){                 // if this matches an existing check-in
                if(compile.records[i].lastTime + ONE_DAY < record.time){ // for this period and check-in has x seperation from last
                    compile.records[i].lastTime = record.time;           // keep track of last valid check-in
                    compile.records[i].checkins++;
                }
                return;
            }
        }
        compile.records.push({name: record.name, checkins:1, lastTime: record.time}); // given this is a new record
    },
    dCount: function(){
        var activeMembers = 0;
        compile.records.forEach(function(member){ // for every member that excedes member activity goal increment active member count
            if(member.checkins >= MEMBER_ACTIVITY_GOAL){
                activeMembers++;
                // slack.send(member.name + ': ' + member.checkins);
            }
        });
        slack.send('We have had ' + activeMembers + ' members actively using the makerspace the past month');
    }
};

var check = {
    activity: function(period){
        mongo.connectAndDo(function onconnect(db){
            check.stream(db.collection('checkins').aggregate([
                { $match: {time: {$gt: period} } },
                { $sort : { time: 1 } }
            ]), db); // pass cursor from query and db objects to start a stream
        }, function onError(error){                                          // doubt this will happen but Murphy
            slack.send('could not connect to database for whatever reason, see logs');
            console.log('connect error ' + error);
        });
    },
    stream: function(cursor, db){
        process.nextTick(function onNextTick(){
            cursor.nextObject(function onMember(error, record){
                if(record){
                    compile.checkins(record);
                    check.stream(cursor, db);  // recursively move through all members in collection
                } else {
                    if(error){
                        slack.send('Error checking database, see logs');
                        console.log('on check: ' + error);
                    } else {        // given we have got to end of stream, list currently active members
                        setTimeout(compile.dCount, 4000);
                        db.close(); // close connection with database
                    }
                }
            });
        });
    }
};

function startup(event, context){
    var date = new Date();
    var currentMonth = date.getMonth();
    date.setMonth(currentMonth - 1);
    check.activity(date.getTime());
}

if(process.env.LAMBDA === 'true'){exports.start = startup;}
else {startup();}
