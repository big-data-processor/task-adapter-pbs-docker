const child_process = require("child_process"),
  os = require("os"),
  process = require("process"),
  path = require("path"),
  EventEmitter = require("events"),
  utilities = require("@big-data-processor/utilities"),
  fse = utilities.fse,
  sleep = utilities.sleep,
  memHumanize = utilities.humanizeMemory,
  spawnProcessAsync = utilities.spawnProcessAsync,
  BdpTaskAdapter = require("@big-data-processor/task-adapter-base");

const __checkJobStatus = function(pbsJobId) {
  return new Promise((resolve, reject) => {
    const qstatProcess = child_process.spawn("qstat", ["-x", "-f", pbsJobId]);
    let jobInfo = "";
    qstatProcess.stdout.on("readable", () => {
      const data = qstatProcess.stdout.read();
      jobInfo += data;
    });
    qstatProcess.on("error", err => reject(err));
    qstatProcess.on("exit", (code) => {
      if (code != 0) {
        return resolve(undefined);
      }
      jobInfo = jobInfo.trim().replace(/\n\t/g, "").split("\n");
      const results = {};
      for (let i = 1; i < jobInfo.length; i++) {
        if (jobInfo[i].indexOf(" = ") !== -1) {
          // Split key and value to 0 and 1
          const data = jobInfo[i].split(" = ");
          results[data[0].trim()] = data[1].trim();
        }
      }
      resolve({jobState: results["job_state"], exitCode: results["Exit_status"]});
    });
  });
};

class BdpPbsAdapter extends BdpTaskAdapter {
  constructor(opt) {
    opt.adapterName = "PBS Pro™";
    opt.adapterAuthor = "Chi Yang: chiyang1118@gmail.com";
    opt.dockerPath = opt.dockerPath || 'docker';
    super(opt);
    this.userInfo = os.userInfo();
    this.options.stdoeMode = "watch";
    this.options.tmpfs = this.options.tmpfs || undefined;
  }
  async stopAllJobs() {
    // const taskIDs = Object.keys(this.runningTasks);
    const deletingPromises = [];
    for (const jobId of this.runningJobs.keys()) {
      const jobObj = this.getJobById(jobId);
      const pbsJobID = jobObj.pid;
      if (!pbsJobID) { continue; }
      process.stderr.write(`[${new Date().toString()}] Stop job: ${pbsJobID} for task: ${jobId}` + "\n");
      deletingPromises.push((async () => {
        await spawnProcessAsync("qdel", [pbsJobID], "qdel-job-" + pbsJobID, {mode: "pipe", verbose: false, shell: true});
        process.stderr.write(`[${new Date().toString()}] qdel ${pbsJobID} executed.` + "\n");
        await sleep(3000);
        const stdoutExists = await fse.pathExists(jobObj.stdout);
        if (stdoutExists) {
          const targetSTDout = path.join(jobObj.option.taskLogFolder, jobObj.taskName, jobId + "-stdout.txt");
          await fse.move(jobObj.stdout, targetSTDout, {overwrite: true});
        }
        const stderrExists = await fse.pathExists(jobObj.stderr);
        if (stderrExists) {
          const targetSTDerr = path.join(jobObj.option.taskLogFolder, jobObj.taskName, taskID + "-stderr.txt");
          await fse.move(jobObj.stderr, targetSTDerr, {overwrite: true});
        }
      })().catch(console.log));
      if (deletingPromises.length >= 10) {
        await (Promise.all(deletingPromises).catch(console.log));
        deletingPromises.length = 0;
      }
    }
    await (Promise.all(deletingPromises).catch(console.log));
  }
  async jobOverrides(jobObj) {
    const taskOption = jobObj.option;
    jobObj.nodes = isNaN(parseInt(taskOption.nodes)) ? 1 : parseInt(taskOption.nodes);
    jobObj.cpus = isNaN(parseFloat(taskOption.cpus)) ? 1 : parseFloat(taskOption.cpus);
    const { value, unit } = memHumanize(taskOption.mem, false, 0);
    jobObj.mem = value + unit.toLowerCase() + "b";
    const argTemplate = await fse.readFile(path.join(__dirname, "arg-recipe.yaml"), "utf8");
    jobObj = await super.parseRecipe(jobObj, argTemplate);
    jobObj.command = "qsub" + " " + jobObj.args.join(" ");
    return jobObj;
  }
  async jobDeploy(jobObj) {
    const jobId = jobObj.jobId;
    const qsubProc = await spawnProcessAsync("qsub", jobObj.args, "submit-job", {mode: "memory", cwd: jobObj.option.cwd || process.cwd()});
    const pbsJobId = qsubProc.stdout.replace(/\n/g, "");
    if (qsubProc.stderr) {
      process.stdout.write('StdErr when qsub: ' + qsubProc.stderr + '\n');
    }
    const matched = pbsJobId.match(/^(\d+)\..*$/);
    if (!matched || !matched[1]) {
      console.log('This job has been sent, but it did NOT return the job ID\n' +
            'Please try increasing the options.delayInterval value to avoid submitting too many jobs at one time.\n' +
            'You might also need to manually delete this unknown job.' + "\n"
            `The job command is 'qsub ${jobObj.args.join(' ')}'`);
      sleep(3000).then(() => this.emitJobStatus(jobObj.jobId, 87, null)).catch(console.log);
    } else {
      jobObj.stdout = path.resolve(process.env.HOME, jobId + ".o" + matched[1]);
      jobObj.stderr = path.resolve(process.env.HOME, jobId + ".e" + matched[1]);
      jobObj.pid = pbsJobId;
    }
    return {
      runningJobId: pbsJobId,
      stdoutStream: null,
      stderrStream: null,
      jobEmitter: new EventEmitter(),
      isRunning: false
    };
  }
  async detectJobStatus() {
    try {
      for (const [jobId, runningJob] of this.runningJobs.entries()) {
        const jobObj = this.getJobById(jobId);
        const pbsJobId = runningJob.runningJobId;
        let jobStateObj;
        try {
          jobStateObj = await __checkJobStatus(pbsJobId);
          if (!jobStateObj) { 
            throw `Failed to retrieve the job status for ${jobId}. Skip this checking.`;
          }
        } catch(err) {
          console.log(err);
          continue;
        }
        const {jobState, exitCode} = jobStateObj;
        // TODO: allow using more jobStats to corrected inform the BDP whether the job stops or not.
        if (jobState === 'F' && exitCode !== undefined) {
          jobObj.stdout = path.join(jobObj.option.taskLogFolder, jobObj.taskName, jobId + "-stdout.txt");
          jobObj.stderr = path.join(jobObj.option.taskLogFolder, jobObj.taskName, jobId + "-stderr.txt");
          await this.emitJobStatus(jobId, exitCode, null);
        } else if (jobState === 'R') {
          runningJob.isRunning = true;
        }
      }
    } catch (err) {
      console.log(err);
    }
  }
}

module.exports = BdpPbsAdapter;
