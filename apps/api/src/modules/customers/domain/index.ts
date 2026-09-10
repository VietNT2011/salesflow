import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { ContactPointInput, WorkspaceRole } from '@salesflow/contracts';
import { AppError } from '../../../errors.js';

export interface CustomerActor {
  userId: string;
  membershipId: string;
  role: WorkspaceRole;
}

export interface NormalizedContactPoint extends ContactPointInput {
  normalizedValue: string;
}

export function normalizeContactPoint(
  contact: ContactPointInput,
  defaultCountry: string,
): NormalizedContactPoint {
  if (contact.type === 'EMAIL') {
    return { ...contact, normalizedValue: contact.value.trim().toLowerCase() };
  }
  if (contact.type === 'PHONE') {
    const country = (contact.country ?? defaultCountry).toUpperCase() as CountryCode;
    const phone = parsePhoneNumberFromString(contact.value, country);
    if (!phone?.isValid()) {
      throw new AppError('INVALID_PHONE', 'Phone number is invalid for the workspace country', 422);
    }
    return { ...contact, country, normalizedValue: phone.number };
  }
  return {
    ...contact,
    normalizedValue: contact.value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(),
  };
}

export function mayCreateCustomer(role: WorkspaceRole): boolean {
  return role !== 'VIEWER';
}

export function mayManageAllCustomers(role: WorkspaceRole): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'CS_MANAGER';
}

export function mayMergeCustomers(role: WorkspaceRole): boolean {
  // F02 deliberately limits destructive identity consolidation to these operational roles.
  return role === 'ADMIN' || role === 'CS_MANAGER';
}

export function maskContact(type: 'PHONE' | 'EMAIL' | 'ADDRESS', value: string): string {
  if (type === 'EMAIL') {
    const [local = '', domain = ''] = value.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (type === 'PHONE') return `***${value.replace(/\D/g, '').slice(-4)}`;
  return '[redacted address]';
}
