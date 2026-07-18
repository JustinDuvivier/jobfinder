/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module and must not be bundled by Next; it is
  // loaded directly from node_modules in the server runtime.
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
