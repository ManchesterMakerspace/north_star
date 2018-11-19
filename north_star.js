// north_star.js ~ Copyright 2018 Manchester Makerspace ~ License MIT
// millisecond conversions
var ONE_DAY = 86400000;
var MEMBER_ACTIVITY_GOAL = 3;              // minimal number of checkin ins needed to count as active
var MEMBER_ACTIVITY_THRESHHOLD = 5;        // number of checkins under to count as inactive
var STREAM_FINALIZATION_OFFSET = 100;      // time to take last action after final doc request in stream
var VERY_ACTIVE_QUALIFIER = 15;            // amount of checkins to qualify as very active
var LONG_TERM_PERIOD = 6;                // months to qualify activity over

var querystring = require('querystring');  // Parse urlencoded body
var crypto = require('crypto');            // verify request from slack is from slack with hmac-256
var https = require('https');
var slack = {
    send: function(msg, useMetric){
        var postData = JSON.stringify({'text': msg});
        var options = {
            hostname: 'hooks.slack.com', port: 443, method: 'POST',
            path: process.env.WEBHOOK_MEMBERSHIP,
            headers: {'Content-Type': "application/json",'Content-Length': postData.length}
        };
        var req = https.request(options, function(res){}); // just do it, no need for response
        req.on('error', function(error){console.log(error);});
        req.write(postData); req.end();
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
    startReportMillis: 0,
    msg: '',
    creatMsg: function(string){compile.msg += string + '\n';},           // helper that adds new lines to compiled results
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
    northStarMetric: function(){ // shows total active members for period given
        var activeMembers = 0;
        compile.records.forEach(function(member){ // for every member that excedes member activity goal increment active member count
            if(member.checkins >= MEMBER_ACTIVITY_GOAL){activeMembers++;}
        });
        return 'We have had ' + activeMembers + ' members actively using the makerspace the past ' + app.durration + ' month' + app.plural;
    },
    veryActiveList: function(onFinish){
        var msg = 'Checked in more than ' + VERY_ACTIVE_QUALIFIER + ' times in ' + app.durration + ' month' + app.plural + '\n ```';
        compile.records.forEach(function(member){
            if(member.checkins >= VERY_ACTIVE_QUALIFIER){msg += '\n' + member.name;}
        });
        return msg += '```';
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
    inactiveList: function(){
        var threshhold = MEMBER_ACTIVITY_THRESHHOLD; // default to member activity goal given no option
        compile.records.forEach(function(member){
            if(member.goodStanding && !member.group){
                if (member.checkins < threshhold) {compile.creatMsg(member.checkins + ' checkin(s): ' + member.name);}
            }
        }); // Run reporting function as a response to an api call, cli invocation, test, or cron
        return  'Inactive members over past ' + app.durration + ' month' + app.plural + '\n```' + compile.msg + '```';
    }
};

var check = {
    error: function(error){console.log('connect error ' + error);},
    activity: function(period, stream, onFinish){
        mongo.connectAndDo(function onconnect(db){
            check.stream(db.collection('checkins').aggregate([
                { $match: {time: {$gt: period} } },
                { $sort : { time: 1 } }
            ]), db, stream, onFinish);       // pass cursor from query and db objects to start a stream
        }, check.error);
    },
    inactivity: function(period, stream, onFinish){
        check.activity(period, stream, check.membership(period, onFinish)); // squeeze in an extra stream to get more information
    },
    membership: function(period, onFinish){
        return function(){
            mongo.connectAndDo(function whenConnected(db){
                check.stream(db.collection('members').find({
                    'expirationTime': {$gt: period}
                }), db, compile.membership, onFinish);
            }, check.error);
            return false; // signal we are still doing something
        };
    },
    stream: function(cursor, db, stream, onFinish){
        process.nextTick(function onNextTick(){                  // forego blocking anything with the stream
            cursor.nextObject(function onDoc(error, record){     // when next document in the stream is ready
                if(record){                                      // as long as stream produces records
                    stream(record);                              // function for streaming docs into
                    check.stream(cursor, db, stream, onFinish);  // recursively move through all members in collection
                } else {
                    if(error){console.log('on check: ' + error);}
                    else {          // given we have got to end of stream, list currently active members
                        setTimeout(onFinish, STREAM_FINALIZATION_OFFSET);
                        db.close(); // close connection with database
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
            streamStart(monthsDurration, compile.checkins, function onFinish(){
                slack.send(finalFunction());
                // console.log(finalFunction()); // for testing purposes
            });
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
                        var msg = finalFunction();                                               // run passed compilation totalling function
                        response.body = JSON.stringify({
                            'response_type' : body.text === 'show' ? 'in_channel' : 'ephemeral', // 'in_channel' or 'ephemeral'
                            'text' : msg
                        });
                        callback(null, response);
                    });
                } else {
                    response.body = JSON.stringify({'response_type': 'ephemeral', 'text': 'Only can be displayed in authorized channels'});
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

if(process.env.LAMBDA === 'true'){
    exports.northstarCron = app.oneTime(compile.northStarMetric, check.activity, 1);
    exports.northstarApi = app.api(compile.northStarMetric, check.activity, 1);
    exports.activeApi = app.api(compile.veryActiveList, check.activity, 6);
    exports.inactiveApi = app.api(compile.inactiveList, check.inactivity, 6, true);
} else {
    app.oneTime(compile.northStarMetric, check.activity, app.monthsDurration(5))();
    // app.oneTime(compile.veryActiveList, check.activity, app.monthsDurration(1))();
    // app.oneTime(compile.inactiveList, check.inactivity, app.monthsDurration(1), true)();
}
