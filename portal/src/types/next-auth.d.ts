import { DefaultSession, DefaultUser } from 'next-auth';
import { DefaultJWT } from 'next-auth/jwt';

// `marketer`: agency marketing specialist — sees every active client at
// once under /marketer (see src/lib/marketerAuth.ts). Admins can open the
// marketer area too; clients cannot.
// `coach`: GMN coach — sees only the clients whose coach_name lists them,
// under /coach (see src/lib/coachAuth.ts). Can open those clients'
// dashboards via impersonation but never gets admin views.
export type UserRole = 'admin' | 'client' | 'marketer' | 'coach';

// Marker on a session minted by "view as client". role says who started it
// (missing on tokens minted before coaches existed = admin); returnTo is where
// "Back" lands; auditId is the impersonation_audit row to close.
export interface ImpersonatedBy {
  id: string;
  email: string;
  role?: 'admin' | 'coach';
  returnTo?: string;
  auditId?: number;
}

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: UserRole;
      clientId: string | null;
      // When set, this session was minted by an admin viewing a client
      // dashboard. The banner + "Return to admin" flow reads this to know
      // which admin to restore.
      impersonatedBy?: ImpersonatedBy | null;
    } & DefaultSession['user'];
  }

  interface User extends DefaultUser {
    role: UserRole;
    clientId: string | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends DefaultJWT {
    id: string;
    role: UserRole;
    clientId: string | null;
    impersonatedBy?: ImpersonatedBy | null;
  }
}
