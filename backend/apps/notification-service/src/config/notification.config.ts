import { registerAs } from '@nestjs/config';

export default registerAs('notification', () => ({
  mongo: {
    uri: process.env.MONGO_URI,
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  nats: {
    url: process.env.NATS_URL ?? 'nats://localhost:4222',
  },
  aws: {
    region: process.env.AWS_REGION ?? 'eu-west-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY,
    fromEmail: process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev',
    fromName: process.env.RESEND_FROM_NAME ?? 'Lagos State Waste Management',
  },
  africastalking: {
    apiKey: process.env.AFRICAS_TALKING_API_KEY,
    username: process.env.AFRICAS_TALKING_USERNAME,
    senderId: process.env.AFRICAS_TALKING_SENDER_ID ?? 'LGSWASTE',
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  rateLimit: {
    emailPerHour: 50, // Max emails per user per hour
    smsPerHour: 10, // Max SMS per user per hour
    pushPerHour: 100, // Max push per user per hour
  },
}));
