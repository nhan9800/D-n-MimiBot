'use strict';

const { performance } = require('node:perf_hooks');

const CHAT_COOLDOWN_MS = 10_000;
const VOICE_MINUTE_MS = 60_000;
const VOICE_XP_PER_MINUTE = 20;
const numeric = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const multiplier = value => Math.min(5, Math.max(0.1, Number(value) || 1));

function voiceEnabled(system) { return Boolean(system && (system.voiceEnabled ?? system.enabled)); }

function awardChatXp(system, user, now = Date.now(), random = Math.random) {
    if (!system?.enabled || !user || user.bot) return null;
    system.chatLastAwardMs ||= {};
    const last = system.chatLastAwardMs[user.id];
    if (Number.isFinite(last) && now - last < CHAT_COOLDOWN_MS) return null;
    system.users ||= {};
    const before = numeric(system.users[user.id]);
    const earned = Math.floor((15 + random() * 10) * multiplier(system.multiplier));
    system.users[user.id] = before + earned;
    system.chatLastAwardMs[user.id] = now;
    return { before, after: before + earned, earned };
}

// Session times use a monotonic clock. Only elapsed time observed by this process
// is awarded; neither restart nor reconnect backfills time while the bot was offline.
class VoiceXpTracker {
    constructor({ getConfig, changed = () => {}, clock = () => performance.now() }) {
        this.getConfig = getConfig; this.changed = changed; this.clock = clock;
        this.sessions = new Map(); this.suspended = new Set();
    }
    eligible(state) {
        return Boolean(state?.channelId && state.member?.user && !state.member.user.bot && !this.suspended.has(state.guild.id) &&
            state.channelId !== state.guild.afkChannelId && voiceEnabled(this.getConfig(state.guild.id).levelSystem));
    }
    settle(guildId, userId, now = this.clock()) {
        const key = `${guildId}:${userId}`;
        const session = this.sessions.get(key);
        if (!session) return null;
        // A stalled process must not award hours after a long suspension.
        const elapsed = Math.min(120_000, Math.max(0, now - session.at));
        session.at = now;
        const system = this.getConfig(guildId).levelSystem;
        if (!elapsed || !voiceEnabled(system)) return null;
        system.voiceUsers ||= {}; system.voiceTimeMs ||= {}; system.voiceRemainderMs ||= {};
        const before = numeric(system.voiceUsers[userId]);
        const accumulated = numeric(system.voiceRemainderMs[userId]) + elapsed;
        const minutes = Math.floor(accumulated / VOICE_MINUTE_MS);
        const earned = minutes * Math.floor(VOICE_XP_PER_MINUTE * multiplier(system.voiceMultiplier));
        system.voiceTimeMs[userId] = Math.floor(numeric(system.voiceTimeMs[userId]) + elapsed);
        system.voiceRemainderMs[userId] = accumulated % VOICE_MINUTE_MS;
        system.voiceUsers[userId] = before + earned;
        this.changed();
        return { userId, before, after: before + earned, earned };
    }
    update(oldState, newState) {
        const state = newState || oldState;
        const key = `${state.guild.id}:${state.id}`;
        const award = this.settle(state.guild.id, state.id);
        if (this.eligible(newState)) {
            if (!this.sessions.has(key)) this.sessions.set(key, { at: this.clock() });
        } else this.sessions.delete(key);
        return award;
    }
    tick(guild) {
        const now = this.clock(); const awards = [];
        for (const [key] of this.sessions) {
            if (!key.startsWith(`${guild.id}:`)) continue;
            const userId = key.slice(guild.id.length + 1);
            const current = guild.voiceStates.cache.get(userId);
            if (this.eligible(current)) {
                const award = this.settle(guild.id, userId, now);
                if (award?.earned) awards.push(award);
            } else this.sessions.delete(key);
        }
        for (const state of guild.voiceStates.cache.values()) {
            const key = `${guild.id}:${state.id}`;
            if (this.eligible(state) && !this.sessions.has(key)) this.sessions.set(key, { at: now });
        }
        return awards;
    }
    forgetGuild(id) { for (const key of this.sessions.keys()) if (key.startsWith(`${id}:`)) this.sessions.delete(key); }
    suspendGuild(id) { this.forgetGuild(id); this.suspended.add(id); }
    resetGuild(guild) { this.forgetGuild(guild.id); this.suspended.delete(guild.id); this.tick(guild); }
}

const inviteUses = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function inviteSnapshot(invites, vanity = null) {
    return { invites: new Map(Array.from(invites.values(), invite => [invite.code, {
        code: invite.code, uses: inviteUses(invite.uses), inviterId: invite.inviter?.id || null
    }])), vanity: vanity && { code: vanity.code, uses: inviteUses(vanity.uses) } };
}

function inferInvite(previous, current, joinCount) {
    const unknown = reason => ({ kind: 'unknown', inviterId: null, code: null, reason });
    if (!previous) return unknown('no_baseline');
    if ([...previous.invites.values(), ...current.invites.values(), previous.vanity, current.vanity]
        .some(invite => invite && inviteUses(invite.uses) === null)) return unknown('missing_metadata');
    const changes = [];
    for (const [code, invite] of current.invites) {
        const old = previous.invites.get(code);
        // A previously unseen invitation has no reliable baseline.
        if (!old && invite.uses > 0) return unknown('new_invite');
        if (old && invite.uses < old.uses) return unknown('counter_reset');
        if (old && invite.uses > old.uses) changes.push({ ...invite, kind: 'invite', delta: invite.uses - old.uses });
    }
    if (Array.from(previous.invites.keys()).some(code => !current.invites.has(code))) return unknown('deleted_invite');
    if (current.vanity && (previous.vanity?.code !== current.vanity.code || current.vanity.uses < previous.vanity.uses)) return unknown('vanity_baseline');
    if (current.vanity && previous.vanity?.code === current.vanity.code && current.vanity.uses > previous.vanity.uses) {
        changes.push({ kind: 'vanity', inviterId: null, code: current.vanity.code, delta: current.vanity.uses - previous.vanity.uses });
    }
    if (changes.length !== 1 || changes[0].delta !== joinCount) return unknown('ambiguous');
    const { kind, code, inviterId } = changes[0];
    return { kind, code, inviterId, reason: null };
}

// Join events close together form one batch. Multiple changed invite counters
// cannot establish which member used which code, so every result stays unknown.
class InviteTracker {
    constructor({ getConfig, save, fetchSnapshot, delayMs = 750, setTimer = setTimeout }) {
        this.getConfig = getConfig; this.save = save; this.fetchSnapshot = fetchSnapshot;
        this.delayMs = delayMs; this.setTimer = setTimer; this.baselines = new Map(); this.jobs = new Map();
    }
    async seed(guild) {
        try { this.baselines.set(guild.id, await this.fetchSnapshot(guild)); return true; }
        catch { this.baselines.delete(guild.id); return false; }
    }
    join(member) {
        if (member.user.bot) return Promise.resolve(null);
        return new Promise(resolve => {
            let job = this.jobs.get(member.guild.id);
            if (!job) {
                job = { guild: member.guild, members: [], departed: new Set(), running: false };
                this.jobs.set(member.guild.id, job);
                this.setTimer(() => this.flush(member.guild.id), this.delayMs);
            }
            job.members.push({ member, resolve });
        });
    }
    async flush(guildId) {
        const job = this.jobs.get(guildId);
        if (!job || job.running) return;
        job.running = true;
        let result;
        try {
            const current = await this.fetchSnapshot(job.guild);
            result = inferInvite(this.baselines.get(guildId), current, job.members.length);
            this.baselines.set(guildId, current);
        } catch {
            this.baselines.delete(guildId);
            result = { kind: 'unknown', inviterId: null, code: null, reason: 'unavailable' };
        }
        const config = this.getConfig(guildId);
        config.inviteTracking ||= { startedAtMs: Date.now(), members: {} };
        config.inviteTracking.members ||= {};
        for (const { member, resolve } of job.members) {
            const old = config.inviteTracking.members[member.id];
            const joinedAtMs = member.joinedTimestamp || Date.now();
            // A duplicate gateway event must not overwrite a known attribution.
            if (!old || old.joinedAtMs !== joinedAtMs) {
                config.inviteTracking.members[member.id] = { ...result, joinedAtMs, leftAtMs: job.departed.has(member.id) ? Date.now() : null };
            }
            resolve(config.inviteTracking.members[member.id]);
        }
        this.jobs.delete(guildId);
        this.save();
    }
    leave(member) {
        this.jobs.get(member.guild.id)?.departed.add(member.id);
        const record = this.getConfig(member.guild.id).inviteTracking?.members?.[member.id];
        if (record && !record.leftAtMs) { record.leftAtMs = Date.now(); this.save(); }
    }
    created(invite) {
        const baseline = this.baselines.get(invite.guild?.id);
        if (baseline && !baseline.invites.has(invite.code)) baseline.invites.set(invite.code, {
            code: invite.code, uses: inviteUses(invite.uses), inviterId: invite.inviter?.id || null
        });
    }
    forgetGuild(id) { this.baselines.delete(id); }
}

function formatMemberTemplate(template, member) {
    const variables = { user: `<@${member.id}>`, username: member.user.username || 'Thành viên', server: member.guild.name,
        count: String(member.guild.memberCount), boosts: String(member.guild.premiumSubscriptionCount || 0) };
    return String(template || '').replace(/\\n/g, '\n').replace(/\{(user|username|server|count|boosts)\}/g, (_, key) => variables[key]);
}

function isNewBoost(oldMember, newMember) {
    return Boolean(!oldMember.partial && !newMember.user.bot && !oldMember.premiumSinceTimestamp && newMember.premiumSinceTimestamp);
}

module.exports = { CHAT_COOLDOWN_MS, VOICE_XP_PER_MINUTE, voiceEnabled, awardChatXp, VoiceXpTracker,
    inviteSnapshot, inferInvite, InviteTracker, formatMemberTemplate, isNewBoost, numeric };
