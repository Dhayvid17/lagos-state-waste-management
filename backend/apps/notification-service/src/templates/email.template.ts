/**
 * Helper to escape HTML special characters to prevent injection/XSS
 */
function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export const EmailTemplates = {
  // ── Welcome email after registration
  welcome: (data: { firstName?: string; email: string }) => ({
    subject: 'Welcome to Lagos State Waste Management Platform',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a7a4a; padding: 20px; text-align: center;">
          <h1 style="color: white; margin: 0;">Lagos State Waste Management</h1>
        </div>
        <div style="padding: 30px;">
          <h2>Welcome${data.firstName ? `, ${escapeHtml(data.firstName)}` : ''}! 🎉</h2>
          <p>Thank you for joining the Lagos State Waste Management platform. 
             Together, we can keep Lagos clean.</p>
          <p>Your account has been created with: <strong>${escapeHtml(data.email)}</strong></p>
          <p>Start by verifying your email and completing your profile.</p>
          <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 0; font-size: 12px; color: #666;">
              Lagos State Waste Management Authority | 
              This email was sent to ${escapeHtml(data.email)}
            </p>
          </div>
        </div>
      </div>
    `,
    text: `Welcome to Lagos State Waste Management! Your account: ${data.email}`,
  }),

  // ── Email verification
  emailVerification: (data: { email: string; token: string; baseUrl: string }) => ({
    subject: 'Verify Your Email — Lagos State Waste Management',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a7a4a; padding: 20px; text-align: center;">
          <h1 style="color: white; margin: 0;">Verify Your Email</h1>
        </div>
        <div style="padding: 30px;">
          <p>Click the button below to verify your email address:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${data.baseUrl}/verify-email?token=${data.token}&email=${encodeURIComponent(data.email)}"
               style="background: #1a7a4a; color: white; padding: 15px 30px; 
                      text-decoration: none; border-radius: 5px; font-size: 16px;">
              Verify Email
            </a>
          </div>
          <p style="color: #666; font-size: 14px;">
            This link expires in 24 hours. If you did not create this account, 
            please ignore this email.
          </p>
        </div>
      </div>
    `,
    text: `Verify your email: ${data.baseUrl}/verify-email?token=${data.token}&email=${data.email}`,
  }),

  // ── Password reset
  passwordReset: (data: { email: string; token: string; baseUrl: string }) => ({
    subject: 'Reset Your Password — Lagos State Waste Management',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a7a4a; padding: 20px; text-align: center;">
          <h1 style="color: white; margin: 0;">Reset Password</h1>
        </div>
        <div style="padding: 30px;">
          <p>You requested a password reset. Click below to proceed:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${data.baseUrl}/reset-password?token=${data.token}"
               style="background: #e74c3c; color: white; padding: 15px 30px; 
                      text-decoration: none; border-radius: 5px; font-size: 16px;">
              Reset Password
            </a>
          </div>
          <p style="color: #666; font-size: 14px;">
            This link expires in 1 hour. If you did not request this, 
            please secure your account immediately.
          </p>
        </div>
      </div>
    `,
    text: `Reset your password: ${data.baseUrl}/reset-password?token=${data.token}`,
  }),

  // ── Report verified
  reportVerified: (data: {
    firstName?: string;
    reportTitle: string;
    reportId: string;
    lgaId: string;
  }) => ({
    subject: '✅ Your Waste Report Has Been Verified',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a7a4a; padding: 20px; text-align: center;">
          <h1 style="color: white; margin: 0;">Report Verified ✅</h1>
        </div>
        <div style="padding: 30px;">
          <p>Hello${data.firstName ? ` ${escapeHtml(data.firstName)}` : ''},</p>
          <p>Your waste report has been verified by the ${escapeHtml(data.lgaId)} LGA office.</p>
          <div style="background: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #1a7a4a;">
            <p style="margin: 0;"><strong>Report:</strong> ${escapeHtml(data.reportTitle)}</p>
            <p style="margin: 5px 0 0;"><strong>Status:</strong> Verified — A collector will be assigned shortly</p>
          </div>
          <p>Thank you for helping keep Lagos clean! 🌿</p>
        </div>
      </div>
    `,
    text: `Your report "${data.reportTitle}" has been verified. A collector will be assigned shortly.`,
  }),

  // ── Report completed + points awarded
  reportCompleted: (data: {
    firstName?: string;
    reportTitle: string;
    pointsAwarded: number;
    totalPoints: number;
  }) => ({
    subject: '🎉 Waste Collected! Points Awarded',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a7a4a; padding: 20px; text-align: center;">
          <h1 style="color: white; margin: 0;">Waste Collected! 🎉</h1>
        </div>
        <div style="padding: 30px;">
          <p>Hello${data.firstName ? ` ${escapeHtml(data.firstName)}` : ''},</p>
          <p>The waste from your report has been successfully collected!</p>
          <div style="background: #e8f5e9; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: center;">
            <h2 style="color: #1a7a4a; margin: 0;">+${data.pointsAwarded} Points</h2>
            <p style="margin: 5px 0 0; color: #666;">Total: ${data.totalPoints} points</p>
          </div>
          <p><strong>Report:</strong> ${escapeHtml(data.reportTitle)}</p>
          <p>Keep reporting waste to earn more points and help Lagos stay clean! 💚</p>
        </div>
      </div>
    `,
    text: `Your report was completed! You earned ${data.pointsAwarded} points. Total: ${data.totalPoints} points.`,
  }),

  // ── Report rejected
  reportRejected: (data: { firstName?: string; reportTitle: string; rejectionReason: string }) => ({
    subject: '❌ Your Waste Report Was Rejected',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #e74c3c; padding: 20px; text-align: center;">
          <h1 style="color: white; margin: 0;">Report Rejected</h1>
        </div>
        <div style="padding: 30px;">
          <p>Hello${data.firstName ? ` ${escapeHtml(data.firstName)}` : ''},</p>
          <p>Unfortunately, your waste report has been rejected.</p>
          <div style="background: #fdecea; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #e74c3c;">
            <p style="margin: 0;"><strong>Report:</strong> ${escapeHtml(data.reportTitle)}</p>
            <p style="margin: 5px 0 0;"><strong>Reason:</strong> ${escapeHtml(data.rejectionReason)}</p>
          </div>
          <p>You may submit a new report with more accurate information.</p>
        </div>
      </div>
    `,
    text: `Your report "${data.reportTitle}" was rejected. Reason: ${data.rejectionReason}`,
  }),

  // ── Account suspended
  accountSuspended: (data: { firstName?: string; reason: string; until?: string }) => ({
    subject: '⚠️ Your Account Has Been Suspended',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #e67e22; padding: 20px; text-align: center;">
          <h1 style="color: white; margin: 0;">Account Suspended</h1>
        </div>
        <div style="padding: 30px;">
          <p>Hello${data.firstName ? ` ${escapeHtml(data.firstName)}` : ''},</p>
          <p>Your account has been suspended.</p>
          <div style="background: #fef9e7; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #e67e22;">
            <p style="margin: 0;"><strong>Reason:</strong> ${escapeHtml(data.reason)}</p>
            ${data.until ? `<p style="margin: 5px 0 0;"><strong>Until:</strong> ${escapeHtml(data.until)}</p>` : ''}
          </div>
          <p>To appeal, contact support@lagoswaste.gov.ng</p>
        </div>
      </div>
    `,
    text: `Your account has been suspended. Reason: ${data.reason}. Contact support@lagoswaste.gov.ng`,
  }),
};

// ── SMS templates — kept short (160 chars max for single SMS)
export const SmsTemplates = {
  reportVerified: (reportId: string) =>
    `LGSWASTE: Your waste report #${reportId.slice(-8)} has been verified. A collector will be assigned shortly.`,

  reportCompleted: (points: number) =>
    `LGSWASTE: Waste collected! You earned ${points} points. Keep reporting to earn more. Thank you!`,

  reportRejected: (reason: string) =>
    `LGSWASTE: Your report was rejected. Reason: ${reason.slice(0, 80)}. Submit a new report with correct details.`,

  reportAssigned: (reportId: string) =>
    `LGSWASTE: A collector has been assigned to report #${reportId.slice(-8)}. Collection will happen soon.`,

  otpVerification: (otp: string) =>
    `LGSWASTE: Your verification code is ${otp}. Valid for 10 minutes. Never share this code.`,
};

// ── Push notification templates
export const PushTemplates = {
  reportCreated: (lgaId: string) => ({
    title: '🗑️ New Waste Report',
    body: `A new waste report has been submitted in ${lgaId}`,
  }),

  reportAssigned: (address?: string) => ({
    title: '📍 New Assignment',
    body: `You have been assigned a collection${address ? ` at ${address}` : ''}`,
  }),

  reportVerified: () => ({
    title: '✅ Report Verified',
    body: 'Your waste report has been verified by your LGA office',
  }),

  reportCompleted: (points: number) => ({
    title: '🎉 Waste Collected!',
    body: `Collection complete! You earned ${points} points`,
  }),

  reportRejected: () => ({
    title: '❌ Report Rejected',
    body: 'Your waste report was rejected. Tap to see the reason.',
  }),
};
