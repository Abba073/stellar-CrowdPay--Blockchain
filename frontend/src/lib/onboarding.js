import { getStorageItem, setStorageItem, removeStorageItem } from './storage';

const CREATOR_KEY = 'cp_onboarding_creator_dismissed';
const CONTRIBUTOR_KEY = 'cp_onboarding_contributor_dismissed';

export function isCreatorOnboardingVisible() {
  return getStorageItem(CREATOR_KEY) !== '1';
}

export function dismissCreatorOnboarding() {
  setStorageItem(CREATOR_KEY, '1');
}

export function isContributorOnboardingVisible() {
  return getStorageItem(CONTRIBUTOR_KEY) !== '1';
}

export function dismissContributorOnboarding() {
  setStorageItem(CONTRIBUTOR_KEY, '1');
}

export function markJustRegistered() {
  setStorageItem('cp_just_registered', '1', 'session');
}

export function consumeJustRegistered() {
  if (getStorageItem('cp_just_registered', 'session') !== '1') return false;
  removeStorageItem('cp_just_registered', 'session');
  return true;
}
