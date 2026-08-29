// Single source of truth for role strings and the role sets scattered across
// the controllers. Defined here now; each controller adopts these as later
// branches touch it, so the arrays stop drifting apart.

export const ROLES = {
    SUPERADMIN: 'superadmin',
    ADMIN: 'admin',
    DO: 'do',
    MEMBER: 'member',
    PASTOR: 'pastor',
    VALIDATOR: 'validator',
    AUDITOR: 'auditor',
};

// Superadmin is the system owner and belongs to no church. Every other role
// does, which is what User.church's conditional `required` keys off.
export const CHURCH_ROLES = [
    ROLES.ADMIN,
    ROLES.DO,
    ROLES.MEMBER,
    ROLES.PASTOR,
    ROLES.VALIDATOR,
    ROLES.AUDITOR,
];

export const ALL_ROLES = [ROLES.SUPERADMIN, ...CHURCH_ROLES];

// ---------------------------------------------------------------------------
// Authorization gates — who may fire an action.
// ---------------------------------------------------------------------------

// See every row in their own church's scoped tables (businessRequirements
// §4.2, §5.4). Used by buildRfScope and buildTithesScope.
export const OVERSIGHT_ROLES = [ROLES.ADMIN, ROLES.AUDITOR, ROLES.PASTOR];

// Tithes approve/reject. Note the route middleware also lists auditor, which
// this then rejects — see businessRequirements §14 item 3.
export const TITHES_REVIEWER_ROLES = [ROLES.DO, ROLES.ADMIN];

// RF stage gates (businessRequirements §5.2).
export const RF_VALIDATE_ROLES = [ROLES.VALIDATOR, ROLES.AUDITOR, ROLES.ADMIN];
export const RF_APPROVE_ROLES = [ROLES.ADMIN, ROLES.AUDITOR, ROLES.PASTOR];
export const RF_REJECT_ROLES = [ROLES.ADMIN, ROLES.VALIDATOR, ROLES.AUDITOR, ROLES.PASTOR];
export const RF_DISBURSE_ROLES = [ROLES.ADMIN, ROLES.DO];

// Voucher visibility, and who may issue or cancel one.
export const VOUCHER_ROLES = [ROLES.VALIDATOR, ROLES.DO, ROLES.AUDITOR, ROLES.ADMIN];
export const VOUCHER_WRITE_ROLES = [ROLES.VALIDATOR, ROLES.ADMIN];

// Manual expense entry.
export const EXPENSE_WRITE_ROLES = [ROLES.ADMIN];

// ---------------------------------------------------------------------------
// Notification recipient sets — who gets told, not who may act. Deliberately
// kept separate from the gates above; they overlap but are not the same lists
// (businessRequirements §9).
// ---------------------------------------------------------------------------

export const NOTIFY_TITHES_SUBMITTED = [ROLES.DO, ROLES.ADMIN];
export const NOTIFY_RF_SUBMITTED = [ROLES.VALIDATOR, ROLES.AUDITOR, ROLES.ADMIN];
export const NOTIFY_RF_VALIDATED = [ROLES.PASTOR, ROLES.AUDITOR, ROLES.ADMIN];
export const NOTIFY_RF_RECEIVED = [ROLES.ADMIN, ROLES.AUDITOR];
export const NOTIFY_VOUCHER_CHANGED = [ROLES.DO, ROLES.AUDITOR, ROLES.ADMIN];
