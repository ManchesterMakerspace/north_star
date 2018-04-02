# North Star

This utility give a key performance metric for the makerspace to judge its success by

Ideally this metric would be based on amount of project attempts / success in a month.

However check-in data indicating use of the space project, volunteer, social or otherwise is readily available through records that doorboto makes in our database

These function(s) look at periods of time like a daily, weekly, or monthly to determine how many practically active members we have at any given time

Spurious data like multiple check ins over the period of a couple minutes to a day are ignored and compared with an ideal member activity goal over a period of time. Greater than 5 check-ins per individual a month would be an example of a member activity goal.

### Makerspace Contributors

Note: Changes deploy to aws lambda on push to master branch using seed.run

Requires installing/running mongod, node, and npm to test locally. Can also require a slack webhook URI as that is its intended target output. Though without it things can be tested by falling back on logs

These are instructions to test locally. For Manchester Makerspace members reach out on the slack #access_control channel if you are interested in working with real data. Running Jitploy with the proper key can decrypt the configuration and run the reminders in production or testing states. The goal with using Jitploy is reproducibility and ease of deployment.

Edit the following command with the right environment, configuration key, and access token to start things up. Using Jitploy without options will start things in sample/demo mode as shown below. Sample configuration exist in /jitploy/sample.yml. The sample assumes a local mongo server is running.

    npm install setup && jitploy north_star.js
