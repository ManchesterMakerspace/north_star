// north_star.js ~ Copyright 2018 Manchester Makerspace ~ License MIT
// millisecond conversions
var ONE_DAY = 86400000;
var DAYS_3  = ONE_DAY * 3;
var DAYS_6 = ONE_DAY * 6;
var DAYS_7 = ONE_DAY * 7;
var DAYS_13 = ONE_DAY * 13;
var DAYS_14 = ONE_DAY * 14;
var MEMBER_ACTIVITY_GOAL = 5; // corilates to minimal number of checkin in a month needed to constitute as an actively using the space

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
    checkins: function(record){ // copiles records into compile.records
        for(var i=0; i<compile.records.length; i++){
            if(compile.records[i].name === record.name){
                compile.records[i].checkins++;
                return;
            }
        }
        compile.records.push({name: record.name, checkins:1}); // given this is a new record
    },
    dCount: function(){
        var activeMembers = 0;
        compile.records.forEach(function(member){ // for every member that excedes member activity goal increment active member count
            if(member.checkins >= MEMBER_ACTIVITY_GOAL){activeMembers++;}
        });
        slack.send('We had ' + activeMembers + ' members actively using the makerspace this month');
    }
};

var check = {
    past: function(period){
        mongo.connectAndDo(function onconnect(db){
            check.stream(db.collection('checkins').find({$gt: period}), db); // pass cursor from query and db objects to start a stream
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
    var kpiChannel = event && event.KPI_CHANNEL ? event.KPI_CHANNEL : process.env.KPI_CHANNEL; // if lambda passes something use it
    slack.init(process.env.SLACK_WEBHOOK_URL, kpiChannel);
    var date = new Date();
    var currentMonth = date.getMonth();
    date.setMonth(currentMonth - 1);
    check.past(date.getTime());
}

if(process.env.LAMBDA === 'true'){exports.start = startup;}
else {
    startup();
    setInterval(startup, ONE_DAY); // just keep it on for testing purposes
}
