/**
 * UniversalTickSystem
 * A fixed-timestep loop that runs at a capped speed (e.g., 60 ticks/sec).
 * Logic is driven by absolute tick counts, not real-time milliseconds.
 * This ensures deterministic simulation behavior regardless of server load.
 */

import Logger from './Logger.js';
import { MAX_TICKS_PER_SECOND } from './Constants.js';

/**
 * Represents a single unit of work to be executed by the Tick System.
 */
export class TickJob {
    /**
     * @param {string} id - Unique identifier for the job.
     * @param {Function} callback - The function to execute (no arguments).
     * @param {number} interval - Frequency in ticks (e.g., 10 = every 10th tick).
     * @param {number} order - Execution priority (0 = highest priority, runs first).
     */
    constructor(id, callback, interval, order) {
        this.id = id;
        this.callback = callback;
        this.interval = interval;
        this.order = order;
    }
}

/**
 * UniversalTickSystem Class
 * Manages the global simulation loop and job execution.
 */
export class UniversalTickSystem {
    /**
     * @param {number} maxTicksPerSecond - The speed limit of the simulation.
     */
    constructor(maxTicksPerSecond = MAX_TICKS_PER_SECOND) {
        this.maxTicksPerSecond = maxTicksPerSecond;
        this.currentTick = 0;
        this.jobs = [];
        this.isRunning = false;
        this._intervalId = null;
    }

    /**
     * Registers a new job into the system.
     * @param {TickJob} job - The job to register.
     */
    register(job) {
        this.jobs.push(job);
        Logger.info(`[TickSystem] Registered job: ${job.id} (Interval: ${job.interval} ticks, Order: ${job.order})`);
    }

    /**
     * Starts the universal tick loop.
     */
    start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        this.currentTick = 0;

        // Calculate the interval in milliseconds based on the desired tick rate
        const intervalMs = 1000 / this.maxTicksPerSecond;
        Logger.info(`[TickSystem] Starting with maxTicksPerSecond=${this.maxTicksPerSecond}, intervalMs=${intervalMs}`);
        
        // DIAGNOSTIC: Log all registered jobs and their expected first tick
        Logger.info(`[TickSystem] DIAGNOSTIC: Registered jobs:`);
        this.jobs.forEach(job => {
            Logger.info(`[TickSystem]   - Job "${job.id}": interval=${job.interval}, order=${job.order}, first_execution_at_tick=0`);
        });

        this._intervalId = setInterval(() => {
            this._executeTick();
            this.currentTick++;
            // Phase 4: demoted from Logger.info to Logger.debug — at 60 ticks/s the
            // info log produced ~60 lines/second of pure noise. The per-tick line is
            // now only visible when explicitly raised to debug level.
            Logger.debug(`[TickSystem] Tick ${this.currentTick} executed. Jobs registered: ${this.jobs.length}`);
        }, intervalMs);
        
        Logger.info(`[TickSystem] World started. Running at ${this.maxTicksPerSecond} ticks/sec.`);
    }

    /**
     * Executes all jobs due for the current absolute tick.
     * @private
     */
    _executeTick() {
        // 1. Filter jobs that are due (Current Tick % Interval == 0)
        const dueJobs = this.jobs.filter(job => this.currentTick % job.interval === 0);

        // 2. Sort by Order (Priority)
        // Lower number = Higher Priority = Runs First
        dueJobs.sort((a, b) => a.order - b.order);

        // 3. Execute
        for (const job of dueJobs) {
            try {
                // Callbacks are empty as requested
                job.callback();
            } catch (error) {
                Logger.error(`[TickSystem] Job ${job.id} failed: ${error.message}`);
            }
        }
    }

    /**
     * Stops the system.
     */
    stop() {
        this.isRunning = false;
        if (this._intervalId) {
            clearInterval(this._intervalId);
            this._intervalId = null;
        }
        Logger.info('[TickSystem] System stopped.');
    }
}
