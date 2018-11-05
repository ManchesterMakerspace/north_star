// north_star.js ~ Copyright 2018 Manchester Makerspace ~ License MIT
// millisecond conversions
var ONE_DAY = 86400000;
var MEMBER_ACTIVITY_GOAL = 3;              // minimal number of checkin ins needed to count as active
var STREAM_FINALIZATION_OFFSET = 100;      // time to take last action after final doc request in stream
var VERY_ACTIVE_QUALIFIER = 15;            // amount of checkins to qualify as very active
var VERY_ACTIVE_PERIOD = 6;                // months to qualify activity over

var request = require('request');          // make http post request and the like
var querystring = require('querystring');  // Parse urlencoded body
var crypto = require('crypto');            // verify request from slack is from slack with hmac-256

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
    northStarMetric: function(){ // shows total active members for period given
        var activeMembers = 0;
        compile.records.forEach(function(member){ // for every member that excedes member activity goal increment active member count
            if(member.checkins >= MEMBER_ACTIVITY_GOAL){activeMembers++;}
        });
        return 'We have had ' + activeMembers + ' members actively using the makerspace the past month';
    },
    veryActiveList: function(onFinish){
        var msg = 'Checked in more than ' + VERY_ACTIVE_QUALIFIER + ' times in ' + VERY_ACTIVE_PERIOD + ' month(s)\n ```';
        compile.records.forEach(function(member){
            if(member.checkins >= VERY_ACTIVE_QUALIFIER){msg += '\n' + member.name;}
        });
        return msg += '```';
    }
};

var check = {
    activity: function(period, onFinish){
        mongo.connectAndDo(function onconnect(db){
            check.stream(db.collection('checkins').aggregate([
                { $match: {time: {$gt: period} } },
                { $sort : { time: 1 } }
            ]), db, onFinish);       // pass cursor from query and db objects to start a stream
        }, function onError(error){console.log('connect error ' + error);});
    },
    stream: function(cursor, db, onFinish){
        process.nextTick(function onNextTick(){
            cursor.nextObject(function onDoc(error, record){
                if(record){
                    compile.checkins(record);
                    check.stream(cursor, db, onFinish);  // recursively move through all members in collection
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
    oneTime: function(finalFunction, monthsDurration){
        return function(event, context){
            check.activity(monthsDurration, function onFinish(){
                slack.send(finalFunction());
                // console.log(finalFunction());
            });
        };
    },
    api: function(finalFunction, monthsDurration){ // pass function that runs when data is compiled, and durration of checkins
        return function(event, context, callback){
            var body = querystring.parse(event.body);              // parse urlencoded body
            var response = {statusCode:403, headers: {'Content-type': 'application/json'}};
            check.activity(monthsDurration, function onFinish(){  // start db request before varification for speed
                var msg = finalFunction();                         // run passed compilation totalling function
                response.body = JSON.stringify({
                    'response_type' : body.text === 'show' ? 'in_channel' : 'ephemeral', // 'in_channel' or 'ephemeral'
                    'text' : msg
                });
                callback(null, response);
            });
            if(varify.request(event)){ response.statusCode = 200;}
            else {
                console.log('failed to varify signature :' + JSON.stringify(event, null, 4));
                callback(null, response);
            }
        };
    },
    monthsDurration: function(monthsBack){
        var date = new Date();
        var currentMonth = date.getMonth();
        date.setMonth(currentMonth - monthsBack);
        return date.getTime();
    }
};

if(process.env.LAMBDA === 'true'){
    module.exports.northstarCron = app.oneTime(compile.northStarMetric, app.monthsDurration(1));
    module.exports.northstarApi = app.api(compile.northStarMetric, app.monthsDurration(1));
    module.exports.activeApi = app.api(compile.veryActiveList, app.monthsDurration(VERY_ACTIVE_PERIOD));
} else {
    app.oneTime(compile.northStarMetric, app.monthsDurration(3))();
}
