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
      return session;
    },
  },

  pages: {
    signIn: '/login',
    error: '/login',
  },

  session: { strategy: 'jwt' },
  secret: process.env.NEXTAUTH_SECRET,
};
