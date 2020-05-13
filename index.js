/**
* kue-based-jobs hook
*
* @docs :: https://sailsjs.com/docs/concepts/extending-sails/hooks
*/

module.exports = function kueJobs(sails) {

    const kue = require("kue");
    const fs = require('fs-extra');
    const Job = kue.Job;
    const path = require('path');
    const cluster = require('cluster');

    let Queue = null;

    let shouldStartKueJobsOnThisProcess = false;
    let shouldStartWebApiOnThisProcess = false;


    /**
    * Build the hook definition.
    * (this is returned below)
    *
    * @type {Dictionary}
    */
    return {

        defaults: {
            kueJobs: {
                redisUrl: 'redis://127.0.0.1:6379',
                enableApi: false,
                apiPort: 3000,
                webApiEnvName: 'IS_MASTER',
                onlyStartOnWorkers: false,
                workerEnvName: 'IS_WORKER',
            },
        },

        configure: async function () {
            let onlyStartOnWorkers = sails.config.kueJobs.onlyStartOnWorkers;
            if (onlyStartOnWorkers) {
                sails.log.info('[Sails Hook][kueJobs] : Set to run only for process which have worker env variable set to true.');
                let isWorker = process.env[sails.config.kueJobs.workerEnvName];
                sails.log.debug('[Sails Hook][kueJobs] : Is Worker:', isWorker);
                if (isWorker || isWorker == 'true') {
                    shouldStartKueJobsOnThisProcess = true;
                }
            } else {
                shouldStartKueJobsOnThisProcess = true;
            }

            let isMaster = process.env[sails.config.kueJobs.webApiEnvName];
            sails.log.debug('[Sails Hook][kueJobs] : Is Master:', isMaster);
            if (isMaster || isMaster == 'true') {
                shouldStartWebApiOnThisProcess = true;
            }

        },

        initialize: async function () {

            let waitForHooksToBeLoaded = [];
            if (sails.hooks.orm) {
                waitForHooksToBeLoaded.push('hook:orm:loaded');
            }

            if (sails.hooks.pubsub) {
                waitForHooksToBeLoaded.push('hook:pubsub:loaded');
            }

            if (sails.hooks.helpers) {
                waitForHooksToBeLoaded.push('hook:helpers:loaded');
            }

            // Check if configuration file is present, otherwise copy it
            try {
                const configFilePath = path.join(__dirname, '../../config/kue-jobs.js');
                const exists = await fs.pathExists(configFilePath);
                if (!exists) {
                    await fs.copy(path.join(__dirname, 'resources/config/kue-jobs.js'), configFilePath);
                    sails.log.info('[Sails Hook][kueJobs] : Success Adding the configuration file.');
                } else {
                    sails.log.info('[Sails Hook][kueJobs] : Configuration file already present.');
                }
            } catch (err) {
                sails.log.error(err);
            }

            // Check if Jobs directory is present inside Api folder..., otherwise create it, and copy demo jobs
            try {
                const jobsDirPath = path.join(__dirname, '../../api/jobs');
                const exists = await fs.pathExists(jobsDirPath);
                if (!exists) {
                    await fs.copy(path.join(__dirname, 'resources/jobs'), jobsDirPath);
                    sails.log.info('[Sails Hook][kueJobs] : Success copying jobs directory.');
                } else {
                    sails.log.info('[Sails Hook][kueJobs] : jobs directory already present.');
                }
            } catch (err) {
                sails.log.error(err);
            }
            // sails.log.info('[Sails Hook][kueJobs]: Configuration Check Finished');

            sails.after(waitForHooksToBeLoaded, function () {
                loadHook();
                sails.log.info('[Sails Hook][kueJobs]: Initializing');
            });
        }
    };


    function loadHook() {

        try {
            // Import Job processors from sails Job Directory
            const jobProcessors = require('require-all')({
                dirname: path.join(__dirname, '../../api/jobs'),
                filter: /(.+(-[j]|[J])ob)\.js$/,
                excludeDirs: /^\.(git|svn)$/,
                recursive: true,
                map: function (name, path) {
                    return name.replace(/-([a-z])/g, function (m, c) {
                        return c.toUpperCase();
                    });
                }
            });

            sails.log.info('[Sails Hook][kueJobs] jobProcessors: ', jobProcessors);

            let redisUrl = sails.config.kueJobs.redisUrl;
            sails.log.debug('[Sails Hook][kueJobs] : Redis Url: ', redisUrl);
            // Create job queue on Jobs service
            Queue = kue.createQueue({
                redis: redisUrl
            });

            // Exposing the Queue Object with sails global
            sails.queue = Queue; // can be used as
            sails.job = Job; // can be used as 
             
            /******************************************************************
            sails.queue.create('emailJob', {
            title: 'Account renewal required',
            to: 'tj@learnboost.com',
            template: 'renewal-email'
            }).delay(milliseconds)
            .priority('high')
            .save();
            
            ******************************************************************/

            Queue._processors = Object.entries(jobProcessors); // Setting job processors on Queue as array
            startWorker();
            startWebUi();
            sails.log.info('[Sails Hook][kueJobs]: Initialized Successfully');

        } catch (err) {
            sails.log.error('[Sails Hook][kueJobs] : Error in loading Hook', err);
        }

    }

    function startWebUi() {
        if (sails.config.kueJobs.enableApi && shouldStartWebApiOnThisProcess) {

            const tcpPortUsed = require('tcp-port-used');

            tcpPortUsed.check(sails.config.kueJobs.apiPort, '127.0.0.1')
                .then((inUse) => {
                    if (inUse) {
                        sails.log.debug(`[Sails Hook][kueJobs]: Port ${sails.config.kueJobs.apiPort} is already in use: ` + inUse);
                    } else {
                        kue.app.listen(sails.config.kueJobs.apiPort);
                        kue.app.set('title', '[Sails Hook][kueJobs] - Queue Management');
                        sails.log.debug(`[Sails Hook][kueJobs]: Initialized Web API Interface on port ${sails.config.kueJobs.apiPort}`);
                    }
                }, (err) => {
                    sails.log.info('[Sails Hook][kueJobs]:', err.message);
                });
        }
    }


    function startWorker() {
        if (shouldStartKueJobsOnThisProcess) {
            logJobs();
            startProcessors();
        } else {
            sails.log.debug('[Sails Hook][kueJobs]: Not Initiating Job Processors b/c it is not a worker process.');
        }

    }

    function startProcessors() {

        if (Queue._processors && Array.isArray(Queue._processors)) {
            Queue._processors.forEach(job => {
                sails.log.debug(`[Sails Hook][kueJobs] Adding jobProcessor: Name: ${job[0]}`);
                Queue.process(job[0], job[1]);
            });
        } else {
            sails.log.debug('[Sails Hook][kueJobs] jobProcessors aren\'t array or is undefined.');
        }

    }

    function logJobs() {
        Queue.on("job enqueue", function (id) {
            Job.get(id, function (err, job) {
                if (err) return;
                sails.log.info("Job '" + job.type + "' (ID: " + id + ") Queued.", JSON.stringify(job.data));
            });
        }).on("job complete", function (id) {
            Job.get(id, function (err, job) {
                if (err) return;
                sails.log.info("Job '" + job.type + "' (ID: " + id + ") completed successfully.", JSON.stringify(job.data));
            });
        }).on("job failed", function (id) {
            Job.get(id, function (err, job) {
                if (err) return;
                sails.log(job._error);
                sails.log("\n");
                sails.log.warn("Job '" + job.type + "' (ID: " + id + ") failed. Error: " + job._error);
            });
        });
    }

};