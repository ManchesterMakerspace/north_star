// north_star.js ~ Copyright 2018 Manchester Makerspace ~ License MIT
// millisecond conversions
var ONE_DAY = 86400000;
var MEMBER_ACTIVITY_GOAL = 3;              // minimal number of checkin ins needed to count as active
var MEMBER_ACTIVITY_THRESHHOLD = 5;        // number of checkins under to count as inactive
var STREAM_FINALIZATION_OFFSET = 100;      // time to take last action after final doc request in stream
var VERY_ACTIVE_QUALIFIER = 15;            // amount of checkins to qualify as very active

var MongoClient = require('mongodb').MongoClient;
var querystring = require('querystring');  // Parse urlencoded body
var crypto = require('crypto');            // verify request from slack is from slack with hmac-256
var https = require('https');
var request = require('request');          // just couldn't figure it out with billing I guess

var slack = {
    send: function(msg, webhook){
        var postData = JSON.stringify({'text': msg});
        var options = {
            hostname: 'hooks.slack.com', port: 443, method: 'POST',
            path: webhook ? webhook : process.env.WEBHOOK_MEMBERSHIP,
            headers: {'Content-Type': 'application/json','Content-Length': postData.length}
        };
        var req = https.request(options, function(res){}); // just do it, no need for response
        req.on('error', function(error){console.log(error);});
        req.write(postData); req.end();
    },
    im: function(user_id, msg){
        var postData = '{"channel": "'+user_id+'", "text":"'+ msg + '"}';
        var options = {
            hostname: 'slack.com', port: 443, method: 'POST',
            path: '/api/chat.postMessage',
            headers: {'Content-type': 'application/json','Content-Length': postData.length, Authorization: 'Bearer ' + process.env.BOT_TOKEN}
        };
        var req = https.request(options, function(res){}); // just do it, no need for response
        req.on('error', function(error){console.log(error);});
        req.write(postData); req.end();
    }
};

var billing = { // methodes to check billing status in slack, to see if a member gets notifications
    processed: 0,
    get: function(record, onFinish){
        var options = {
            url: 'https://slack.com/api/team.billableInfo', //' lookupByEmail',
            method: 'GET',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            qs: {'token': process.env.BOT_TOKEN, 'user': record.slack_id} // , 'email': email}
        };
        request(options, function onResponse(error, res, body){
            if(error){console.log(error);}
            else{
                var resBody = JSON.parse(body);
                if(resBody.ok){
                    var billingMsg = resBody.billable_info[record.slack_id].billing_active ? '' : ' inactive in slack, contact:' + record.email;
                    slack.send(record.checkins + ' checkin(s): ' + record.name + billingMsg, process.env.MEMBER_RELATION_WH);
                } else {console.log('failed to retrieve billable info');} // probably want a real error handler here
            }
        });
    }
};

var compile = {
    records: [],
    startReportMillis: 0,
    msg: '',
    zeros: 0,
    ignoreList: ['Landlords Fob', "Landlord's Fob 2"], // Not a great way to this but its more space efficient than alternitives
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
    northStarMetric: function(onFinish){ // shows total active members for period given
        var activeMembers = 0;
        compile.records.forEach(function(member){ // for every member that excedes member activity goal increment active member count
            if(member.checkins >= MEMBER_ACTIVITY_GOAL){activeMembers++;}
        });
        onFinish('We have had ' + activeMembers + ' members actively using the makerspace the past ' + app.durration + ' month' + app.plural);
    },
    veryActiveList: function(onFinish){
        var msg = 'Checked in more than ' + VERY_ACTIVE_QUALIFIER + ' times in ' + app.durration + ' month' + app.plural + '\n ```';
        compile.records.forEach(function(member){
            if(member.checkins >= VERY_ACTIVE_QUALIFIER){msg += '\n' + member.name;}
        });
        onFinish(msg += '```');
    },
    membership: function(record){ // only members in good standing are filtered through
        for(var ignore=0; ignore<compile.ignoreList.length; ignore++){ // e.g. landlord activity is redundant
            if(record.fullname === compile.ignoreList[ignore]){return;}       // ignores non member records
        }
        for(var i=0; i<compile.records.length; i++){                   // check if we have a local record in memory to update
            if(compile.records[i].name === record.fullname){           // if this matches an existing check-in
                compile.records[i].slack_id = record.slack.slack_id;   // tack on slack ids from aggregation
                compile.records[i].email= record.slack.slack_email;    // tack email with slack from aggregation as well
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
            if(record.groupName){ /*console.log('0 checkin(s): ' + record.fullname + '(' + record.groupName + ')');*/} // leave for potentailly following up with groups
            else                {
                compile.zeros++;
                billing.get({slack_id: record.slack.slack_id, email: record.slack.slack_email, name: record.fullname, checkins: 0});
            }
        }
    },
    inactiveList: function(onFinish){
        for(var i =0; i < compile.records.length; i++){
            if(compile.records[i].goodStanding && !compile.records[i].group){
                if (compile.records[i].checkins < MEMBER_ACTIVITY_THRESHHOLD){
                    billing.get(compile.records[i], onFinish);
                }
            }
        } // Run reporting function as a response to an api call, cli invocation, test, or cron
        onFinish('Inactive members over past ' + app.durration + ' month' + app.plural);
    }
};

var check = {
    error: function(error){console.log('connect error ' + error);},
    activity: function(period, stream, onFinish){
        MongoClient.connect(process.env.MONGODB_URI, {useNewUrlParser: true}, function onConnect(connectError, client){
            if(client){
                check.stream(client.db(process.env.DB_NAME).collection('checkins').aggregate(
                    {$match: {time: {$gt: period} } },
                    {$sort : {time: 1 } }
                ), client, stream, onFinish);
            } else {check.error(connectError);}
        });
    },
    inactivity: function(period, stream, onFinish){
        check.activity(period, stream, function(){
            MongoClient.connect(process.env.MONGODB_URI, {useNewUrlParser: true}, function onConnect(connectError, client){
                if(client){
                    check.streamNoClose(client.db(process.env.DB_NAME).collection('checkins').aggregate(
                        {$match: {time: {$gt: period} } },
                        {$sort : {time: 1 } }
                    ), client, stream, function onFirstStreamFinish(){
                        check.stream(client.db(process.env.DB_NAME).collection('members').aggregate([
                            { $match: {'expirationTime': {$gt: period}} },
                            { $lookup: { from: 'slack_users', localField: '_id', foreignField: 'member_id', as: 'slack_users'}},
                            { $project: {
                                fullname: {$concat: ['$firstname', ' ', '$lastname']},
                                _id: 1, expirationTime: 1, groupName: 1,
                                slack: {$arrayElemAt: ["$slack_users", 0]}
                             } }
                        ]), client, compile.membership, onFinish);
                    });
                } else {check.error(connectError);}
            });
        });
    },
    streamNoClose: function(cursor, client, stream, onFinish){
        process.nextTick(function onNextTick(){                     // forego blocking anything with the stream
            cursor.next(function onDoc(error, record){              // when next document in the stream is ready
                if(record){                                         // as long as stream produces records
                    stream(record);                                 // function for streaming docs into
                    check.stream(cursor, client, stream, onFinish); // recursively move through all members in collection
                } else {
                    if(error){console.log('on check: ' + error);}
                    else {setTimeout(onFinish, STREAM_FINALIZATION_OFFSET);}
                }
            });
        });
    },
    stream: function(cursor, client, stream, onFinish){
        process.nextTick(function onNextTick(){                     // forego blocking anything with the stream
            cursor.next(function onDoc(error, record){              // when next document in the stream is ready
                if(record){                                         // as long as stream produces records
                    stream(record);                                 // function for streaming docs into
                    check.stream(cursor, client, stream, onFinish); // recursively move through all members in collection
                } else {
                    if(error){console.log('on check: ' + error);}
                    else {          // given we have got to end of stream, list currently active members
                        setTimeout(onFinish, STREAM_FINALIZATION_OFFSET);
                        client.close(); // close connection with database
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
    durration : 0,
    plural: 's',
    oneTime: function(finalFunction, streamStart, monthsBack, private){
        return function(event, context){
            var monthsDurration = app.monthsDurration(monthsBack);
            streamStart(monthsDurration, compile.checkins, function onFinish(){finalFunction(slack.send);});
        };
    },
    private: function(isPrivate, body){ // logic for deciding on wether to show information
        if(isPrivate){                  // given privacy flag is being passed otherwise just return true to display anywhere
            if(body.channel_id === process.env.PRIVATE_VIEW_CHANNEL || body.user_name === process.env.ADMIN){
                return true;
            } else {
                console.log(body.user_name + ' is curious'); // see who wants to help with members relations
                return false;
            }
        } else {return true;}
    },
    api: function(finalFunction, streamStart, monthsBack, private){ // pass function that runs when data is compiled, and durration of checkins
        return function(event, context, callback){
            var body = querystring.parse(event.body);                                            // parse urlencoded body
            var response = {statusCode:403, headers: {'Content-type': 'application/json'}};      // default case
            if(varify.request(event)){                                                           // verify signing secret
                response.statusCode = 200;
                if(app.private(private, body)){                                                  // determine cases to show if private flag
                    var monthsDurration = app.monthsDurration(monthsBack);
                    streamStart(monthsDurration, compile.checkins, function onFinish(){          // start db request before varification for speed
                        finalFunction(function(msg){                                             // run passed compilation totalling function
                            slack.im(body.user_id, msg);
                            response.body = JSON.stringify({
                                'response_type' : 'ephemeral',                                   // 'in_channel' or 'ephemeral'
                                'text' : 'check slackbot for response'
                            });
                            callback(null, response);
                        });
                    });
                } else {
                    response.body = JSON.stringify({'response_type': 'ephemeral', 'text': 'Only shown to those in members relations, notifying them, thanks for the interest'});
                    callback(null, response);
                }
            } else {
                console.log('failed to varify signature :' + JSON.stringify(event, null, 4));
                callback(null, response);
            }
        };
    },
    monthsDurration: function(monthsBack){
        app.durration = monthsBack;
        app.plural = app.durration > 1 ? 's' : '';
        var date = new Date();
        compile.startReportMillis = date.getTime();
        var currentMonth = date.getMonth();
        date.setMonth(currentMonth - app.durration);
        return date.getTime();
    }
};

exports.northstarCron = app.oneTime(compile.northStarMetric, check.activity, 1);
exports.northstarApi = app.api(compile.northStarMetric, check.activity, 1);
exports.activeApi = app.api(compile.veryActiveList, check.activity, 6);
exports.inactiveApi = app.api(compile.inactiveList, check.inactivity, 6, true);
exports.testApi = function(event, context, callback){
    var body = querystring.parse(event.body);                                            // parse urlencoded body
    var response = {statusCode:403, headers: {'Content-type': 'application/json'}};      // default case
    if(varify.request(event)){                                                           // verify signing secret
        slack.send('<!channel> ' + body.txt, process.env.MEMBER_RELATION_WH);
        response.statusCode = 200;
        response.body = JSON.stringify({
            'response_type' : 'ephemeral',                                               // 'in_channel' or 'ephemeral'
            'text' : 'test message sent'
        });
        callback(null, response);
    } else {
        console.log('failed to varify signature :' + JSON.stringify(event, null, 4));
        callback(null, response);
    }
};
// if(!module.parent){} // run stand alone test
