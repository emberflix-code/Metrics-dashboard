import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { query } from './db';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: 'admin' | 'client';
  client_id: string | null;
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const [user] = await query<UserRow>(
          `SELECT u.id, u.email, u.password_hash, u.role, cu.client_id
           FROM users u
           LEFT JOIN client_users cu ON cu.user_id = u.id
           WHERE u.email = $1
           LIMIT 1`,
          [credentials.email.toLowerCase().trim()]
        );

        if (!user) return null;

        const valid = await bcrypt.compare(credentials.password, user.password_hash);
        if (!valid) return null;

        return {
          id: user.id,
          email: user.email,
          role: user.role,
          clientId: user.client_id,
        };
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.clientId = user.clientId;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.id;
      session.user.role = token.role;
      session.user.clientId = token.clientId;
      // Preserved when the token was minted by the impersonation endpoint —
      // the client dashboard renders a banner + return-to-admin button off it.
      session.user.impersonatedBy = token.impersonatedBy ?? null;
      return session;
    },
  },

  pages: {
    signIn: '/login',
    error: '/login',
  },

  session: { strategy: 'jwt' },
  secret: process.env.NEXTAUTH_SECRET,

  // Prod (HTTPS): cookies must be SameSite=None; Secure for GHL iframe embed.
  // Dev (HTTP localhost): browsers reject Secure cookies on plain HTTP, so the
  // session cookie set on /login never comes back to /admin and middleware
  // rebounces to login. Fall back to non-Secure/SameSite=lax when not on HTTPS.
  cookies: (() => {
    const isProd = (process.env.NEXTAUTH_URL || '').startsWith('https://');
    const secure = isProd;
    const sameSite: 'none' | 'lax' = isProd ? 'none' : 'lax';
    const prefix = isProd ? '__Secure-' : '';
    const csrfPrefix = isProd ? '__Host-' : '';
    return {
      sessionToken: {
        name: `${prefix}next-auth.session-token`,
        options: { httpOnly: true, sameSite, path: '/', secure },
      },
      callbackUrl: {
        name: `${prefix}next-auth.callback-url`,
        options: { httpOnly: true, sameSite, path: '/', secure },
      },
      csrfToken: {
        name: `${csrfPrefix}next-auth.csrf-token`,
        options: { httpOnly: true, sameSite, path: '/', secure },
      },
    };
  })(),
};
