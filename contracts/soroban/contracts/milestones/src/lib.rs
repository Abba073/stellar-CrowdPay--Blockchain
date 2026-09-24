#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol, Vec, IntoVal
};

#[derive(Clone, Copy, PartialEq, Eq)]
#[contracttype]
pub enum MilestoneStatus {
    Pending = 0,
    Submitted = 1,
    Approved = 2,
    Rejected = 3,
}

#[derive(Clone)]
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
}

pub const TOTAL_BPS: u32 = 10000;

/// Validates a milestone plan: non-empty, every entry > 0 bps, sum == 10000.
pub fn validate_plan(milestones: &Vec<Milestone>) {
    if milestones.is_empty() {
        panic!("At least one milestone required");
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

// Define the interface for the Escrow contract
#[contract]
pub struct MilestonesContract;

// Note: We use invoke_contract for cross-contract calls to avoid strict build dependencies
// on the escrow wasm during the initial build of this contract.
// Note: If the wasm is not available yet, we can use a manual client definition.
// Since we are building this together, I'll use a manual client to avoid build order issues.

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
    }

    pub fn submit_milestone(env: Env, index: u32, evidence_hash: BytesN<32>) {
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

        env.events().publish(
            (symbol_short!("submit"), index),
            evidence_hash,
        );
    }

    pub fn approve_milestone(env: Env, index: u32) {
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

        env.events().publish(
            (symbol_short!("approve"), index),
            (),
        );
    }

    pub fn reject_milestone(env: Env, index: u32, reason_hash: BytesN<32>) {
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

        env.events().publish(
            (symbol_short!("reject"), index),
            reason_hash,
        );
    }

    pub fn get_milestone(env: Env, index: u32) -> Milestone {
        let milestones: Vec<Milestone> = env.storage().instance().get(&DataKey::Milestones).expect("Not initialized");
        milestones.get(index).expect("Invalid index")
    }

    pub fn get_all_milestones(env: Env) -> Vec<Milestone> {
        env.storage().instance().get(&DataKey::Milestones).expect("Not initialized")
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn plan(env: &Env, bps: &[u32]) -> Vec<Milestone> {
        let mut v = Vec::new(env);
        for b in bps {
            v.push_back(Milestone {
                title_hash: BytesN::from_array(env, &[0u8; 32]),
                release_bps: *b,
                status: MilestoneStatus::Pending,
                evidence_hash: None,
            });
        }
        v
    }

    fn try_init(bps: &[u32]) -> bool {
        let env = Env::default();
        let id = env.register(MilestonesContract, ());
        let client = MilestonesContractClient::new(&env, &id);
        let (a, b, c) = (Address::generate(&env), Address::generate(&env), Address::generate(&env));
        client.try_initialize(&a, &b, &c, &plan(&env, bps)).is_ok()
    }

    #[test]
    fn initialize_accepts_valid_plans() {
        assert!(try_init(&[10000]));
        assert!(try_init(&[3333, 3333, 3334]));
        assert!(try_init(&[2500, 2500, 5000]));
    }

    #[test]
    fn initialize_rejects_invalid_plans() {
        assert!(!try_init(&[]));
        assert!(!try_init(&[5000, 4000]));
        assert!(!try_init(&[6000, 6000]));
        assert!(!try_init(&[0, 10000]));
        assert!(!try_init(&[0]));
    }

    #[test]
    fn remainder_goes_to_final_release() {
        // 3 milestones of 33.33/33.33/33.34% on 100 raised: 33 + 33 + remainder 34.
        let total: i128 = 100;
        let bps = [3333u32, 3333, 3334];
        let mut released: i128 = 0;
        for (i, b) in bps.iter().enumerate() {
            let is_last = i == bps.len() - 1;
            released += release_amount_for(total, *b, released, is_last);
        }
        assert_eq!(released, total);
    }

    #[test]
    fn total_withdrawn_equals_total_raised_across_n_milestones() {
        for n in 1u32..=10 {
            let base = 10000 / n;
            let mut bps = [base; 10];
            bps[(n - 1) as usize] += 10000 - base * n;
            for total in [1i128, 7, 99, 1_000_003, 123_456_789_012_345] {
                let mut released: i128 = 0;
                for i in 0..n {
                    released += release_amount_for(total, bps[i as usize], released, i == n - 1);
                }
                assert_eq!(released, total, "n={} total={}", n, total);
            }
        }
    }
}
