import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/** Database-only reconcile pass: leases, wake-ups, idle stop, pool, activity refresh. */
crons.interval("lifecycle reconcile", { seconds: 30 }, internal.lifecycle.reconciler.tick);

/** One Daytona list call: detect deleted/stopped-behind-our-back sandboxes and leaked VMs. */
crons.interval("daytona observe", { minutes: 2 }, internal.lifecycle.daytona.observe);

export default crons;
