// north_star.js ~ Copyright 2018 Manchester Makerspace ~ License MIT
// millisecond conversions
var ONE_DAY     = 86400000;
var WEEK_MILLIS = 604800000;
var THIRTY_DAYS = ONE_DAY * 30;
var MEMBER_ACTIVITY_GOAL = 3; // corilates to minimal number of checkin in a month needed to constitute as an actively using the space
var PERIOD = 'month';

var slack = {
    webhook: require('@slack/client').IncomingWebhook,   // url to slack intergration called "webhook" can post to any channel as a "bot"
    init: function(webhook, kpiChannel){
        slack.kpiChannel = {
            username: 'Member Activity Bot',
            channel: kpiChannel,
            iconEmoji: ':star:'
        };
        slack.URL = webhook;
    },
    send: function(msg){
        if(slack.URL){
            var sendObj = {};
            sendObj = new slack.webhook(slack.URL, slack.kpiChannel);
            sendObj.send(msg);
        } else {              // given no url was passed in init phase log to stdout
            console.log(msg); // log messages if no webhook was given
        }
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
    week: 0,
    startReportMillis: 0,
    startTime: 0,
    checkins: function(record){                                          // copiles records into compile.records
        for(var ignore=0; ignore<compile.ignoreList.length; ignore++){   // e.g. landlord activity is redundant
            if(record.name  === compile.ignoreList[ignore]){return;}     // ignores non member records
        }
        if(compile.week){ // given that this start time is greater than the current week counter iterate to the next week
            if(record.time > compile.startTime + WEEK_MILLIS * compile.week){
                var turnedInactive = 0;
                var becameActive = 0;
                var totalActivity = 0;
                var morethanone = 0;
                var morethantwo = 0;
                var morethanthree = 0;
                for(var rec=0; rec < compile.records.length; rec++){
                    if(compile.records[rec].became){                           // if they became active this week
                        // console.log(compile.records[rec].name + ' became active');
                        becameActive++;
                        totalActivity++;
                    } else if(compile.records[rec].retained){                  // if they retained activity from last week
                        totalActivity++;
                    } else if(compile.week - compile.records[rec].week === 1){ // if they were active last week but not this week
                        // console.log(compile.records[rec].name + ' became inactive');
                        turnedInactive++;
                    }
                    if(compile.records[rec].checkins > 1){morethanone++;}
                    if(compile.records[rec].checkins > 2){morethantwo++;}
                    if(compile.records[rec].checkins > 3){morethanthree++;}
                    compile.records[rec].totalCheckins += compile.records[rec].checkins;
                    compile.records[rec].checkins = 0;
                    compile.records[rec].became = false;   // clean up record for next week
                    compile.records[rec].retained = false; // clean up record for next week
                }
                console.log('Week '+compile.week+': Hopped on-'+becameActive+' ~Droped off-'+turnedInactive+' Checked in at least once~'+totalActivity+' ~twice~ '+morethanone+' ~three~ '+morethantwo+' ~four~ '+morethanthree);
                compile.week++; // increment week
            }
        } else { // establish when first record occured, to report week by week after first record
            compile.startTime = record.time;
            compile.week = 1;
        }
        // establish when a record is in next period and file a report if so and start compiling next week
        for(var i=0; i<compile.records.length; i++){                     // check if we have a local record in memory to update
            if(compile.records[i].name === record.name){                 // if this matches an existing check-in
                if(compile.records[i].lastTime + ONE_DAY < record.time){ // for this period and check-in has x seperation from last
                    compile.records[i].lastTime = record.time;           // keep track of last valid check-in
                    compile.records[i].checkins++;                       // note how many times checked in (level of activity)
                    var diff = compile.week - compile.records[i].week;   // difference between current and last week recorded
                    if(diff){                                            // was there an activity difference
                        if(diff > 1){                                    // given its been more than one week since last record activity
                            compile.records[i].became = true;            // set became active to true
                        } else {                                         // given member was active last week
                            compile.records[i].retained = true;          // set retained activity to true
                        }
                    }                                                    // if diff is zero we are just adding more activity in same week
                    compile.records[i].week = compile.week;              // note week of activity
                }
                return; // in this way we add a new record given no current reasult or update a record
            }
        }
        compile.records.push({
            name: record.name,
            checkins: 1,
            totalCheckins: 0,
            lastTime: record.time,
            week: compile.week,
            became: true,
            retained: false,
            goodStanding: false,
            paying: true
        }); // given this is a new record
    },
    membership: function(record){ // only members in good standing are filtered through
        var fullname = record.firstname + ' ' + record.lastname;
        for(var ignore=0; ignore<compile.ignoreList.length; ignore++){ // e.g. landlord activity is redundant
            if(fullname === compile.ignoreList[ignore]){return;}       // ignores non member records
        }
        for(var i=0; i<compile.records.length; i++){                   // check if we have a local record in memory to update
            if(compile.records[i].name === fullname){                  // if this matches an existing check-in
                if(record.groupName){                                  // make a note of paying members
                    compile.records[i].paying = false;
                    compile.records[i].goodStanding = true;            // NOTE think about this if a group expires
                } else if(record.expirationTime > compile.startReportMillis){
                    compile.records[i].goodStanding = true;            // not that this member is in good standing to later figure active members in good standing
                }
                return;                                                // break stream action on finding a positive result
            }
        }
        // This need to occur after potential return cases above
        if(record.expirationTime > compile.startReportMillis){
            if(record.groupName){console.log('0 checkin(s): ' + fullname + '(' + record.groupName + ')');}
            else                {console.log('0 checkin(s): ' + fullname);}
        } else {
            console.log('0 checkin(s): ' + fullname + ' # EXPIRED # ');
        }
    },
    fullReport: function(){
        var VERY_ACTIVE_QUALIFIER = 4;
        console.log('Unique members that checked in ' + compile.records.length);
        var most = {name: '', checkins: 0};
        var barelyActive = 0;
        var totalCheckins = 0;
        for(var i=0; i<compile.records.length; i++){
            if(compile.records[i].goodStanding){
                if     (compile.records[i].totalCheckins < 2 ){console.log('1 checkin(s): ' + compile.records[i].name);}
                else if(compile.records[i].totalCheckins < 3 ){console.log('2 checkin(s): ' + compile.records[i].name);}
            } else {
                console.log(compile.records[i].name + ' was active but expired during this period');
            }
            if(compile.records[i].totalCheckins > most.checkins){
                most.name = compile.records[i].name;
                most.checkins = compile.records[i].totalCheckins;
            }
            if(compile.records[i].totalCheckins < VERY_ACTIVE_QUALIFIER && compile.records[i].paying){barelyActive++;}
            // else if(compile.records[i].totalCheckins >= VERY_ACTIVE_QUALIFIER){console.log(compile.records[i].name + ' is highly active');}
            // console.log(compile.records[i].name + ": " + compile.records[i].totalCheckins);
            totalCheckins += compile.records[i].totalCheckins;
        }
        // console.log('Most checkins: ' + most.name + ' ' + most.checkins + ' / membership collectively checkedin ' + totalCheckins + ' days in this ' + PERIOD);
        console.log('Total paying members that checked in less than ' + VERY_ACTIVE_QUALIFIER + ' days durring this ' + PERIOD + ': ' + barelyActive);
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
    error: function(error){
        // slack.send('could not connect to database for whatever reason, see logs');
        console.log('connect error ' + error);
    },
    past: function(period){
        mongo.connectAndDo(function onconnect(db){
            check.stream(db.collection('checkins').aggregate([
                { $match: {time: {$gt: period} } },
                { $sort : { time: 1 } }
            ]), db, compile.checkins, check.membership(period)); // pass cursor from query and db objects to start a stream
        }, check.error);
    },
    membership: function(period){
        return function(){
            mongo.connectAndDo(function whenConnected(db){
                check.stream(db.collection('members').find({'expirationTime': {$gt: period}}), db, compile.membership, compile.fullReport);
            }, check.error);
        };
    },
    stream: function(cursor, db, streamAction, onComplete){
        process.nextTick(function onNextTick(){
            cursor.nextObject(function onMember(error, record){
                if(record){
                    streamAction(record);
                    check.stream(cursor, db, streamAction, onComplete);  // recursively move through all members in collection
                } else {
                    if(error){
                        slack.send('Error checking database, see logs');
                        console.log('on check: ' + error);
                    } else {                                                 // given we have got to end of stream, list currently active members
                        setTimeout(function(){onComplete();}, 2000); // stream should take care of this in look at drop offs and take ups
                        db.close();
                    }
                }
            });
        });
    }
};

function startup(event, context){
    var kpiChannel = event && event.KPI_CHANNEL ? event.KPI_CHANNEL : process.env.KPI_CHANNEL; // if lambda passes something use it
    slack.init(process.env.SLACK_WEBHOOK_URL, kpiChannel);
    var date = new Date();
    compile.startReportMillis = date.getTime();
    console.log('Check in records for the last ' + PERIOD);
    var currentMonth = date.getMonth();
    date.setMonth(currentMonth - 1);
    check.past(date.getTime());
}

if(process.env.LAMBDA === 'true'){exports.start = startup;}
else {startup();}
