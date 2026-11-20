#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol, Vec, IntoVal
};

// ~1 year in ledgers (5s per ledger)
const INSTANCE_TTL_BUMP: u32 = 6_312_000;
const INSTANCE_TTL_THRESHOLD: u32 = 100_000;

pub const MAX_MILESTONES: u32 = 32;
pub const TOTAL_BPS: u32 = 10000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MilestoneError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    EmptyPlan = 3,
    InvalidBps = 4,
    TotalBpsMismatch = 5,
    MaxMilestonesExceeded = 6,
    IndexOutOfBounds = 7,
    InvalidStatus = 8,
    Unauthorized = 9,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[contracttype]
pub enum MilestoneStatus {
    Pending = 0,
    Submitted = 1,
    Approved = 2,
    Rejected = 3,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct Milestone {
    pub title_hash: BytesN<32>,
    pub release_bps: u32,
    pub status: MilestoneStatus,
    pub evidence_hash: Option<BytesN<32>>,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Creator,
    Platform,
    Escrow,
    Milestones,
    Initialized,
    Released,
    Paused,
    PendingPlatform,
    Version,
}

/// Validates a milestone plan: non-empty, max 32 entries, every entry > 0 bps, sum == 10000.
pub fn validate_plan(milestones: &Vec<Milestone>) {
    if milestones.is_empty() {
        panic!("At least one milestone required");
    }
    if milestones.len() > MAX_MILESTONES {
        panic!("Milestones plan exceeds maximum allowed limit of 32");
    }
    let mut total_bps: u64 = 0;
    for m in milestones.iter() {
        if m.release_bps == 0 {
            panic!("Milestone BPS must be greater than zero");
        }
        total_bps += m.release_bps as u64;
    }
    if total_bps != TOTAL_BPS as u64 {
        panic!("Total BPS must be 10000");
    }
}

/// Amount to release for a milestone. The final release sweeps everything not yet
/// released, so truncation dust from `total * bps / 10000` is never stranded.
pub fn release_amount_for(total_raised: i128, release_bps: u32, already_released: i128, is_last: bool) -> i128 {
    if is_last {
        total_raised - already_released
    } else {
        (total_raised * (release_bps as i128)) / (TOTAL_BPS as i128)
    }
}

#[contract]
pub struct MilestonesContract;

#[contractimpl]
impl MilestonesContract {
    pub fn initialize(
        env: Env,
        creator: Address,
        platform: Address,
        escrow: Address,
        milestones: Vec<Milestone>,
    ) {
        if env.storage().instance().has(&DataKey::Initialized) {
            panic!("Already initialized");
        }

        validate_plan(&milestones);

        env.storage().instance().set(&DataKey::Creator, &creator);
        env.storage().instance().set(&DataKey::Platform, &platform);
        env.storage().instance().set(&DataKey::Escrow, &escrow);
        env.storage().instance().set(&DataKey::Milestones, &milestones);
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);
    }

    pub fn submit_milestone(env: Env, index: u32, evidence_hash: BytesN<32>) {
        Self::require_not_paused(&env);
        let creator: Address = env.storage().instance().get(&DataKey::Creator).expect("Not initialized");
        creator.require_auth();

        let mut milestones: Vec<Milestone> = env.storage().instance().get(&DataKey::Milestones).expect("Not initialized");
        let mut milestone = milestones.get(index).expect("Invalid index");

        if milestone.status != MilestoneStatus::Pending && milestone.status != MilestoneStatus::Rejected {
            panic!("Milestone already submitted or approved");
        }

        milestone.status = MilestoneStatus::Submitted;
        milestone.evidence_hash = Some(evidence_hash.clone());
        milestones.set(index, milestone);
        env.storage().instance().set(&DataKey::Milestones, &milestones);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);

        env.events().publish(
            (symbol_short!("submit"), index),
            evidence_hash,
        );
    }

    pub fn approve_milestone(env: Env, index: u32) {
        Self::require_not_paused(&env);
        let platform: Address = env.storage().instance().get(&DataKey::Platform).expect("Not initialized");
        platform.require_auth();

        let mut milestones: Vec<Milestone> = env.storage().instance().get(&DataKey::Milestones).expect("Not initialized");
        let mut milestone = milestones.get(index).expect("Invalid index");

        if milestone.status != MilestoneStatus::Submitted {
            panic!("Milestone not submitted");
        }

        milestone.status = MilestoneStatus::Approved;
        let release_bps = milestone.release_bps;
        milestones.set(index, milestone);
        env.storage().instance().set(&DataKey::Milestones, &milestones);

        let is_last = milestones.iter().all(|m| m.status == MilestoneStatus::Approved);
        let released: i128 = env.storage().instance().get(&DataKey::Released).unwrap_or(0);

        let escrow_address: Address = env.storage().instance().get(&DataKey::Escrow).expect("Not initialized");
        let creator: Address = env.storage().instance().get(&DataKey::Creator).expect("Not initialized");

        // Use a cross-contract call to get the total raised amount from escrow
        let total_raised: i128 = env.invoke_contract(&escrow_address, &Symbol::new(&env, "get_total_raised"), Vec::new(&env));
        
        let release_amount = release_amount_for(total_raised, release_bps, released, is_last);

        if release_amount > 0 {
            env.storage().instance().set(&DataKey::Released, &(released + release_amount));

            // Approve the withdrawal in escrow (Milestones contract must be the Admin of Escrow)
            let _ : () = env.invoke_contract(&escrow_address, &Symbol::new(&env, "approve_withdrawal"), (release_amount,).into_val(&env));
            
            // Execute the withdrawal
            let _ : () = env.invoke_contract(&escrow_address, &Symbol::new(&env, "execute_withdrawal"), (creator.clone(), release_amount).into_val(&env));
            
            env.events().publish(
                (symbol_short!("release"), index),
                (creator, release_amount),
            );
        }

        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);

        env.events().publish(
            (symbol_short!("approve"), index),
            (),
        );
    }

    pub fn reject_milestone(env: Env, index: u32, reason_hash: BytesN<32>) {
        Self::require_not_paused(&env);
        let platform: Address = env.storage().instance().get(&DataKey::Platform).expect("Not initialized");
        platform.require_auth();

        let mut milestones: Vec<Milestone> = env.storage().instance().get(&DataKey::Milestones).expect("Not initialized");
        let mut milestone = milestones.get(index).expect("Invalid index");

        if milestone.status != MilestoneStatus::Submitted {
            panic!("Milestone not submitted");
        }

        milestone.status = MilestoneStatus::Rejected;
        milestones.set(index, milestone);
        env.storage().instance().set(&DataKey::Milestones, &milestones);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);

        env.events().publish(
            (symbol_short!("reject"), index),
            reason_hash,
        );
    }

    /// Propose a new platform key. Takes effect when the nominee accepts.
    pub fn propose_platform(env: Env, new_platform: Address) {
        let platform: Address = env.storage().instance().get(&DataKey::Platform).expect("Not initialized");
        platform.require_auth();
        env.storage().instance().set(&DataKey::PendingPlatform, &new_platform);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);
    }

    /// Accept a pending platform nomination. Must be called by the nominee.
    pub fn accept_platform(env: Env) {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingPlatform)
            .expect("No pending platform");
        pending.require_auth();
        env.storage().instance().set(&DataKey::Platform, &pending);
        env.storage().instance().remove(&DataKey::PendingPlatform);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);
    }

    /// Freeze/unfreeze milestone submission and approval during an incident.
    pub fn set_paused(env: Env, paused: bool) {
        let platform: Address = env.storage().instance().get(&DataKey::Platform).expect("Not initialized");
        platform.require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    /// Record a migration version. Soroban contracts are upgraded by deploying a
    /// new contract and updating the registry; this entrypoint records the bump.
    pub fn migrate(env: Env, version: u32) {
        let platform: Address = env.storage().instance().get(&DataKey::Platform).expect("Not initialized");
        platform.require_auth();
        let current: u32 = env.storage().instance().get(&DataKey::Version).unwrap_or(0);
        if version <= current {
            panic!("Version must increase");
        }
        env.storage().instance().set(&DataKey::Version, &version);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);
    }

    pub fn get_version(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Version).unwrap_or(0)
    }

    fn require_not_paused(env: &Env) {
        let paused: bool = env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
        if paused {
            panic!("Contract is paused");
        }
    }

    pub fn get_milestone(env: Env, index: u32) -> Milestone {
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);
        let milestones: Vec<Milestone> = env.storage().instance().get(&DataKey::Milestones).expect("Not initialized");
        milestones.get(index).expect("Invalid index")
    }

    pub fn get_all_milestones(env: Env) -> Vec<Milestone> {
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);
        env.storage().instance().get(&DataKey::Milestones).expect("Not initialized")
    }
}

#[cfg(test)]
mod test;
