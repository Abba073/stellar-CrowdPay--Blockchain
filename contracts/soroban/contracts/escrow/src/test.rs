#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env,
};

fn create_token_contract<'a>(env: &Env, admin: &Address) -> (token::Client<'a>, token::StellarAssetClient<'a>) {
    let contract_address = env.register_stellar_asset_contract_v2(admin.clone()).address();
    (
        token::Client::new(env, &contract_address),
        token::StellarAssetClient::new(env, &contract_address),
    )
}

fn setup_escrow<'a>(
    env: &Env,
    admin: &Address,
    target: i128,
    deadline: u64,
    asset: &Address,
) -> EscrowContractClient<'a> {
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);
    client.initialize(admin, &1u64, &target, &deadline, asset);
    client
}

#[test]
fn test_initialize_and_getters() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, _) = create_token_contract(&env, &token_admin);

    let client = setup_escrow(&env, &admin, 1000, 1000, &token_client.address);

    assert_eq!(client.get_total_raised(), 0);
    assert_eq!(client.get_asset(), token_client.address);
}

#[test]
#[should_panic(expected = "Contract is already initialized")]
fn test_double_initialize_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, _) = create_token_contract(&env, &token_admin);

    let client = setup_escrow(&env, &admin, 1000, 1000, &token_client.address);
    client.initialize(&admin, &2u64, &2000, &2000, &token_client.address);
}

#[test]
fn test_deposit_success_and_accounting() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor1 = Address::generate(&env);
    let contributor2 = Address::generate(&env);

    stellar_client.mint(&contributor1, &1000);
    stellar_client.mint(&contributor2, &1000);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);

    // Contributor 1 deposits 300
    client.deposit(&contributor1, &300);
    assert_eq!(client.get_total_raised(), 300);
    assert_eq!(token_client.balance(&contributor1), 700);
    assert_eq!(token_client.balance(&client.address), 300);

    // Contributor 1 deposits another 200
    client.deposit(&contributor1, &200);
    assert_eq!(client.get_total_raised(), 500);
    assert_eq!(token_client.balance(&contributor1), 500);
    assert_eq!(token_client.balance(&client.address), 500);

    // Contributor 2 deposits 400
    client.deposit(&contributor2, &400);
    assert_eq!(client.get_total_raised(), 900);
    assert_eq!(token_client.balance(&contributor2), 600);
    assert_eq!(token_client.balance(&client.address), 900);
}

#[test]
#[should_panic(expected = "Deadline has passed")]
fn test_deposit_after_deadline_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &500);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);

    env.ledger().set_timestamp(500);
    client.deposit(&contributor, &100);
}

#[test]
fn test_deposit_auth() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &500);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);

    client.deposit(&contributor, &100);
    assert!(env.auths().iter().any(|(addr, _)| addr == &contributor));
}

#[test]
fn test_approve_and_execute_withdrawal() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    let recipient = Address::generate(&env);
    stellar_client.mint(&contributor, &1000);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &1000);

    // Approve partial withdrawal of 400
    client.approve_withdrawal(&admin, &400);

    // Execute partial withdrawal of 400 to recipient
    client.execute_withdrawal(&admin, &recipient, &400);
    assert_eq!(token_client.balance(&recipient), 400);
    assert_eq!(token_client.balance(&client.address), 600);

    // Approve next withdrawal of 600
    client.approve_withdrawal(&admin, &600);
    client.execute_withdrawal(&admin, &recipient, &600);
    assert_eq!(token_client.balance(&recipient), 1000);
    assert_eq!(token_client.balance(&client.address), 0);
}

#[test]
#[should_panic(expected = "Insufficient approved amount")]
fn test_execute_withdrawal_without_approval_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    let recipient = Address::generate(&env);
    stellar_client.mint(&contributor, &1000);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &1000);

    client.execute_withdrawal(&admin, &recipient, &100);
}

#[test]
#[should_panic(expected = "Insufficient approved amount")]
fn test_execute_withdrawal_exceeding_approved_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    let recipient = Address::generate(&env);
    stellar_client.mint(&contributor, &1000);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &1000);

    client.approve_withdrawal(&admin, &300);
    client.execute_withdrawal(&admin, &recipient, &301);
}

#[test]
fn test_approve_withdrawal_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, _) = create_token_contract(&env, &token_admin);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);

    env.mock_all_auths();
    client.approve_withdrawal(&admin, &500);
    assert_eq!(env.auths().len(), 1);
    assert_eq!(env.auths()[0].0, admin);
}

#[test]
#[should_panic(expected = "Deadline has not passed")]
fn test_refund_before_deadline_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &500);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &300);

    // Deadline is 500, current timestamp is 100
    client.refund(&contributor);
}

#[test]
#[should_panic(expected = "Campaign succeeded, refunds unavailable")]
fn test_refund_after_success_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &1000);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &1000);

    // Fast-forward past deadline
    env.ledger().set_timestamp(501);
    client.refund(&contributor);
}

#[test]
fn test_refund_when_target_not_met() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor1 = Address::generate(&env);
    let contributor2 = Address::generate(&env);
    stellar_client.mint(&contributor1, &500);
    stellar_client.mint(&contributor2, &500);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor1, &300);
    client.deposit(&contributor2, &200);

    assert_eq!(client.get_total_raised(), 500);
    assert_eq!(token_client.balance(&client.address), 500);

    // Past deadline
    env.ledger().set_timestamp(501);

    // Contributor 1 refunds
    client.refund(&contributor1);
    assert_eq!(token_client.balance(&contributor1), 500);
    assert_eq!(token_client.balance(&client.address), 200);

    // Contributor 2 refunds
    client.refund(&contributor2);
    assert_eq!(token_client.balance(&contributor2), 500);
    assert_eq!(token_client.balance(&client.address), 0);
}

#[test]
#[should_panic(expected = "No contribution to refund")]
fn test_double_refund_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &500);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &300);

    env.ledger().set_timestamp(501);
    client.refund(&contributor);
    // Second refund attempt
    client.refund(&contributor);
}

#[test]
#[should_panic(expected = "No contribution to refund")]
fn test_refund_non_contributor_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, _) = create_token_contract(&env, &token_admin);

    let non_contributor = Address::generate(&env);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);

    env.ledger().set_timestamp(501);
    client.refund(&non_contributor);
}

#[test]
#[should_panic(expected = "Unauthorized caller")]
fn test_unauthorized_approve_milestone_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let unauthorized_user = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, _) = create_token_contract(&env, &token_admin);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.approve_milestone_withdrawal(&unauthorized_user, &200);
}

#[test]
#[should_panic(expected = "Campaign failed, cannot withdraw funds")]
fn test_failed_campaign_withdrawal_blocked() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &300);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &300);

    // After deadline passed and target not met
    env.ledger().set_timestamp(501);
    client.withdraw(&admin, &300);
}


#[test]
fn test_failed_execute_withdrawal_leaves_approval_unchanged() {
#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env,
};

fn create_token_contract<'a>(env: &Env, admin: &Address) -> (token::Client<'a>, token::StellarAssetClient<'a>) {
    let contract_address = env.register_stellar_asset_contract_v2(admin.clone()).address();
    (
        token::Client::new(env, &contract_address),
        token::StellarAssetClient::new(env, &contract_address),
    )
}

fn setup_escrow<'a>(
    env: &Env,
    admin: &Address,
    target: i128,
    deadline: u64,
    asset: &Address,
) -> EscrowContractClient<'a> {
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);
    client.initialize(admin, &1u64, &target, &deadline, asset);
    client
}

#[test]
fn test_initialize_and_getters() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, _) = create_token_contract(&env, &token_admin);

    let client = setup_escrow(&env, &admin, 1000, 1000, &token_client.address);

    assert_eq!(client.get_total_raised(), 0);
    assert_eq!(client.get_asset(), token_client.address);
}

#[test]
#[should_panic(expected = "Contract is already initialized")]
fn test_double_initialize_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, _) = create_token_contract(&env, &token_admin);

    let client = setup_escrow(&env, &admin, 1000, 1000, &token_client.address);
    client.initialize(&admin, &2u64, &2000, &2000, &token_client.address);
}

#[test]
fn test_deposit_success_and_accounting() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);
    let contributor = Address::generate(&env);
    let recipient = Address::generate(&env);
    stellar_client.mint(&contributor, &500);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &500);

    // Approve more than the contract holds so the token transfer fails.
    client.approve_withdrawal(&1000);
    assert!(client.try_execute_withdrawal(&recipient, &1000).is_err());
    // The approval must not be consumed by a failed transfer.
    assert_eq!(client.get_approved_withdrawal(), 1000);
}

#[test]
fn test_refund_clears_balance_without_leaking_state() {

    let contributor1 = Address::generate(&env);
    let contributor2 = Address::generate(&env);

    stellar_client.mint(&contributor1, &1000);
    stellar_client.mint(&contributor2, &1000);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);

    // Contributor 1 deposits 300
    client.deposit(&contributor1, &300);
    assert_eq!(client.get_total_raised(), 300);
    assert_eq!(token_client.balance(&contributor1), 700);
    assert_eq!(token_client.balance(&client.address), 300);

    // Contributor 1 deposits another 200
    client.deposit(&contributor1, &200);
    assert_eq!(client.get_total_raised(), 500);
    assert_eq!(token_client.balance(&contributor1), 500);
    assert_eq!(token_client.balance(&client.address), 500);

    // Contributor 2 deposits 400
    client.deposit(&contributor2, &400);
    assert_eq!(client.get_total_raised(), 900);
    assert_eq!(token_client.balance(&contributor2), 600);
    assert_eq!(token_client.balance(&client.address), 900);
}

#[test]
#[should_panic(expected = "Deadline has passed")]
fn test_deposit_after_deadline_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &500);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);

    env.ledger().set_timestamp(500);
    client.deposit(&contributor, &100);
}

#[test]
fn test_deposit_auth() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &500);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);

    client.deposit(&contributor, &100);
    assert!(env.auths().iter().any(|(addr, _)| addr == &contributor));
}

#[test]
fn test_approve_and_execute_withdrawal() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    let recipient = Address::generate(&env);
    stellar_client.mint(&contributor, &1000);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &1000);

    // Approve partial withdrawal of 400
    client.approve_withdrawal(&400);

    // Execute partial withdrawal of 400 to recipient
    client.execute_withdrawal(&recipient, &400);
    assert_eq!(token_client.balance(&recipient), 400);
    assert_eq!(token_client.balance(&client.address), 600);

    // Approve next withdrawal of 600
    client.approve_withdrawal(&600);
    client.execute_withdrawal(&recipient, &600);
    assert_eq!(token_client.balance(&recipient), 1000);
    assert_eq!(token_client.balance(&client.address), 0);
}

#[test]
#[should_panic(expected = "Insufficient approved amount")]
fn test_execute_withdrawal_without_approval_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    let recipient = Address::generate(&env);
    stellar_client.mint(&contributor, &1000);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &1000);

    client.execute_withdrawal(&recipient, &100);
}

#[test]
#[should_panic(expected = "Insufficient approved amount")]
fn test_execute_withdrawal_exceeding_approved_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    let recipient = Address::generate(&env);
    stellar_client.mint(&contributor, &1000);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &1000);

    client.approve_withdrawal(&300);
    client.execute_withdrawal(&recipient, &301);
}

#[test]
fn test_approve_withdrawal_auth() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);
    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);
    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &1000);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &1000);

    client.approve_withdrawal(&500);
    assert_eq!(env.auths().len(), 1);
    assert_eq!(env.auths()[0].0, admin);
}

#[test]
#[should_panic(expected = "Deadline has not passed")]
fn test_refund_before_deadline_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &500);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &300);

    // Deadline is 500, current timestamp is 100
    client.refund(&contributor);
}

#[test]
#[should_panic(expected = "Campaign succeeded, refunds unavailable")]
fn test_refund_after_success_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);
    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &400);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &400);

    env.ledger().set_timestamp(600);
    client.refund(&contributor);

    assert_eq!(token_client.balance(&contributor), 400);
    assert_eq!(client.get_total_raised(), 0);

    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &1000);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &1000);

    // Fast-forward past deadline
    env.ledger().set_timestamp(501);
    client.refund(&contributor);
}

#[test]
fn test_refund_when_target_not_met() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor1 = Address::generate(&env);
    let contributor2 = Address::generate(&env);
    stellar_client.mint(&contributor1, &500);
    stellar_client.mint(&contributor2, &500);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor1, &300);
    client.deposit(&contributor2, &200);

    assert_eq!(client.get_total_raised(), 500);
    assert_eq!(token_client.balance(&client.address), 500);

    // Past deadline
    env.ledger().set_timestamp(501);

    // Contributor 1 refunds
    client.refund(&contributor1);
    assert_eq!(token_client.balance(&contributor1), 500);
    assert_eq!(token_client.balance(&client.address), 200);

    // Contributor 2 refunds
    client.refund(&contributor2);
    assert_eq!(token_client.balance(&contributor2), 500);
    assert_eq!(token_client.balance(&client.address), 0);
}

#[test]
#[should_panic(expected = "No contribution to refund")]
fn test_double_refund_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &500);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &300);

    env.ledger().set_timestamp(501);
    client.refund(&contributor);
    // Second refund attempt
    client.refund(&contributor);
}

#[test]
#[should_panic(expected = "No contribution to refund")]
fn test_refund_non_contributor_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, _) = create_token_contract(&env, &token_admin);

    let non_contributor = Address::generate(&env);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);

    env.ledger().set_timestamp(501);
    client.refund(&non_contributor);
}

#[test]
#[should_panic(expected = "Unauthorized caller")]
fn test_unauthorized_approve_milestone_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let unauthorized_user = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, _) = create_token_contract(&env, &token_admin);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.approve_milestone_withdrawal(&unauthorized_user, &200);
}

#[test]
#[should_panic(expected = "Campaign failed, cannot withdraw funds")]
fn test_failed_campaign_withdrawal_blocked() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);

    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &300);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &300);

    // After deadline passed and target not met
    env.ledger().set_timestamp(501);
    client.withdraw(&admin, &300);
}


#[test]
#[should_panic(expected = "Campaign has not succeeded")]
fn test_approve_withdrawal_after_failed_campaign_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);
    let contributor = Address::generate(&env);
    stellar_client.mint(&contributor, &500);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &500);

    // Deadline passes without reaching the target: funds must stay refundable.
    env.ledger().set_timestamp(600);
    client.approve_withdrawal(&500);
}

#[test]
#[should_panic(expected = "Insufficient approved amount")]
fn test_approve_then_revoke_blocks_execution() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token_client, stellar_client) = create_token_contract(&env, &token_admin);
    let contributor = Address::generate(&env);
    let recipient = Address::generate(&env);
    stellar_client.mint(&contributor, &1000);

    let client = setup_escrow(&env, &admin, 1000, 500, &token_client.address);
    client.deposit(&contributor, &1000);
    client.approve_withdrawal(&400);
    client.revoke_withdrawal(&400);
    client.execute_withdrawal(&recipient, &400);
}
