// inactivity_indicator.js ~ Copyright 2018 Manchester Makerspace ~ License MIT
// millisecond conversions
var ONE_DAY     = 86400000;
var WEEK_MILLIS = 604800000;
var THIRTY_DAYS = ONE_DAY * 30;
var MEMBER_ACTIVITY_GOAL = 5;              // minimal number of checkin in a month needed to count as active
var MONTH_MULTIPLE = 6;
var PERIOD = MONTH_MULTIPLE + ' month(s)';
var STREAM_FINALIZATION_OFFSET = 100;      // time to take last action after final doc request in stream

var crypto = require('crypto');                      // verify request from slack is from slack with hmac-256
var querystring = require('querystring');            // Parse urlencoded body
var request = require('request');                    // make http post request and the like

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
    msg: '',
    ignoreList: ['Landlords Fob', "Landlord's Fob 2"], // Not a great way to this but its more space efficient than alternitives
    startReportMillis: 0,
    creatMsg: function(string){compile.msg += string + '\n';},           // helper that adds new lines to compiled results
    checkins: function(record){                                          // copiles records into compile.records
        for(var ignore=0; ignore<compile.ignoreList.length; ignore++){   // e.g. landlord activity is redundant
            if(record.name  === compile.ignoreList[ignore]){return;}     // ignores non member records
        } // establish when a record is in next period and file a report if so and start compiling next period
        for(var i=0; i<compile.records.length; i++){                     // check if we have a local record in memory to update
            if(compile.records[i].name === record.name){                 // if this matches an existing check-in
                if(compile.records[i].lastTime + ONE_DAY < record.time){ // for this period and check-in has x seperation from last
                    compile.records[i].lastTime = record.time;           // keep track of last valid check-in
                    compile.records[i].checkins++;                       // note how many times checked in (level of activity)
                }
                return; // in this way we add a new record given no current reasult or update a record
            }
        }               // else given this is a new member to add to the records push a new array item
        compile.records.push({name: record.name,checkins: 1,lastTime: record.time,goodStanding: false,group: ''});
    },
    membership: function(record){ // only members in good standing are filtered through
        var fullname = record.firstname + ' ' + record.lastname;
        for(var ignore=0; ignore<compile.ignoreList.length; ignore++){ // e.g. landlord activity is redundant
            if(fullname === compile.ignoreList[ignore]){return;}       // ignores non member records
        }
        for(var i=0; i<compile.records.length; i++){                   // check if we have a local record in memory to update
            if(compile.records[i].name === fullname){                  // if this matches an existing check-in
                if(record.groupName){                                  // make a note of paying members
                    compile.records[i].group = record.groupName;
                    compile.records[i].goodStanding = true;            // NOTE think about this if a group expires
                } else if(record.expirationTime > compile.startReportMillis){ // filter in those in current good standing
                    compile.records[i].goodStanding = true;            // not that this member is in good standing to later figure active members in good standing
                }
                return;                                                // break stream action on finding a positive result
            }
        } // This needs to occur after potential return cases above
        if(record.expirationTime > compile.startReportMillis){
            if(record.groupName){ /*console.log('0 checkin(s): ' + fullname + '(' + record.groupName + ')');*/} // leave for potentailly following up with groups
            else                {compile.creatMsg('0 checkin(s): ' + fullname);}
        }
    },
    fullReport: function(onFinish, threshholdOverride){
        return function(){
            var threshhold = threshholdOverride ? threshholdOverride : MEMBER_ACTIVITY_GOAL; // default to member activity goal given no option
            compile.records.forEach(function(member){
                if(member.goodStanding && !member.group){
                    if (member.checkins < threshhold) {compile.creatMsg(member.checkins + ' checkin(s): ' + member.name);}
                }
            });
            onFinish(compile.msg); // Run reporting function as a response to an api call, cli invocation, test, or cron
        };
    }
};

var check = {
    error: function(error){console.log('connect error ' + error);},
    activity: function(period, onFinish){
        mongo.connectAndDo(function onconnect(db){
            check.stream(db.collection('checkins').aggregate([
                { $match: {time: {$gt: period} } },
                { $sort : { time: 1 } }
            ]), db, compile.checkins, check.membership(period, onFinish)); // pass cursor from query and db objects to start a stream
        }, check.error);
    },
    membership: function(period, onFinish){
        return function(){
            mongo.connectAndDo(function whenConnected(db){
                check.stream(db.collection('members').find({'expirationTime': {$gt: period}}), db, compile.membership, compile.fullReport(onFinish));
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
                    if(error){ console.log('on check: ' + error);
                    } else {                                                               // given we have got to end of stream, list currently active members
                        setTimeout(function(){onComplete();}, STREAM_FINALIZATION_OFFSET); // stream should take care of this in look at drop offs and take ups
                        db.close();
                    }
                }
            });
        });
    }
};

var varify = {
    slack_sign_secret: process.env.SLACK_SIGNING_SECRET,
    request: function(event){
        var timestamp = event.headers['X-Slack-Request-Timestamp'];        // nonce from slack to have an idea
        var secondsFromEpoch = Math.round(new Date().getTime() / 1000);    // get current seconds from epoch because thats what we are comparing with
        if(Math.abs(secondsFromEpoch - timestamp > 60 * 5)){return false;} // make sure request isn't a duplicate
        var computedSig = 'v0=' + crypto.createHmac('sha256', varify.slack_sign_secret).update('v0:' + timestamp + ':' + event.body).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(event.headers['X-Slack-Signature'], 'utf8'), Buffer.from(computedSig ,'utf8'));
    }
};

var app = {
    lambda: function(event, context, callback){
        var body = querystring.parse(event.body);                                    // parse urlencoded body
        var response = {status: 403, headers: {'Content-type': 'application/json'}}; // default response, unauthorized
        console.log('channel id: ' + body.channel_id + ' | user name ' + body.user_name);
        if(varify.request(event)){
            response.statusCode = 200;
            if(body.channel_id === process.env.PRIVATE_VIEW_CHANNEL || body.user_name === process.env.ADMIN){
                app.check(function onFinish(msg){
                    if(response.statusCode === 200){
                        response.body = JSON.stringify({
                            'response_type' : 'in_channel', // 'ephemeral' or 'in_channel'
                            'text' : 'Compiling members that checked in less than ' + MEMBER_ACTIVITY_GOAL + ' times in ' + MONTH_MULTIPLE + ' months. \n' + msg
                        });
                    }
                    callback(null, response);
                });
            } else {
                console.log(body.user_name + ' is curious');
                response.body = JSON.stringify({
                    'response_type' : 'ephemeral', // 'ephemeral' or 'in_channel'
                    'text' : 'This information can only be displayed in unauthorized channels',
                });
                callback(null, response);
            }
        } else { callback(null, response); }
    },
    check: function(onFinish){
        var date = new Date();
        compile.startReportMillis = date.getTime();
        var currentMonth = date.getMonth();
        date.setMonth(currentMonth - MONTH_MULTIPLE);
        check.activity(date.getTime(), onFinish);
    },
    response: function(msg){
        var options = {
            uri: process.env.WEBHOOK_URL_MEMBERS_RELATIONS,
            method: 'POST',
            json: {'text': '```' + msg + '```'}
        };
        request(options, function requestResponse(error, response, body){
            if(error){console.log('webhook request error ' + error);}
        });
    }
};

if(process.env.LAMBDA === 'true'){exports.start = app.lambda;}
else {app.check(function(msg){console.log(msg);});}
