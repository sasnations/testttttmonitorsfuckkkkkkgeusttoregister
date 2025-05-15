import express from 'express';
import smtpManager from '../services/smtpManager.js';
import { body, validationResult } from 'express-validator';
import { pool } from '../db/init.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// Validation middleware
const validateGuestPostSubmission = [
  body('fullName').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('websiteUrl').isURL().withMessage('Valid website URL is required'),
  body('niche').trim().notEmpty().withMessage('Niche is required'),
  body('message').optional().trim()
];

// Admin passphrase middleware
const checkAdminPassphrase = (req, res, next) => {
  const adminPassphrase = req.get('Admin-Access');
  
  if (!adminPassphrase || adminPassphrase !== process.env.ADMIN_PASSPHRASE) {
    return res.status(401).json({ 
      success: false, 
      message: 'Unauthorized access'
    });
  }
  
  next();
};

// Store submission and send email notification
router.post('/submit', validateGuestPostSubmission, async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { fullName, email, websiteUrl, niche, message } = req.body;
    
    // 1. Store the submission in the database
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      
      const [result] = await connection.query(`
        INSERT INTO guest_post_submissions (
          name, email, website_url, niche, message, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NOW())
      `, [
        fullName,
        email,
        websiteUrl,
        niche,
        message || '',
        'pending' // Initial status
      ]);
      
      const submissionId = result.insertId;
      
      // 2. Send notification email using SMTP rotation
      const emailHtml = `
        <h2>New Guest Post Exchange Request</h2>
        <p><strong>Submission ID:</strong> ${submissionId}</p>
        <p><strong>Name:</strong> ${fullName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Website:</strong> <a href="${websiteUrl}" target="_blank">${websiteUrl}</a></p>
        <p><strong>Niche:</strong> ${niche}</p>
        <p><strong>Message:</strong> ${message || 'No message provided'}</p>
        <hr>
        <p>To respond to this request, please contact the submitter directly via email.</p>
      `;
      
      await smtpManager.sendEmail(
        process.env.NOTIFICATION_EMAIL || 'support@boomlify.com',
        'New Guest Post Exchange Request',
        emailHtml
      );
      
      // 3. Send confirmation email to the submitter
      const confirmationHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 5px;">
          <h2 style="color: #4A90E2;">Thank You for Your Guest Post Request</h2>
          
          <p>Hello ${fullName},</p>
          
          <p>We've received your request for a guest post and backlink exchange with Boomlify. Here's a summary of what you submitted:</p>
          
          <ul style="background-color: #f9f9f9; padding: 15px; border-radius: 5px;">
            <li><strong>Name:</strong> ${fullName}</li>
            <li><strong>Website:</strong> ${websiteUrl}</li>
            <li><strong>Niche:</strong> ${niche}</li>
          </ul>
          
          <p>What happens next?</p>
          
          <ol>
            <li>Our team will review your website and niche to ensure it aligns with our content.</li>
            <li>We'll reach out to you via email (${email}) within 2-3 business days.</li>
            <li>We'll discuss content topics, placement, and other details to make this collaboration beneficial for both parties.</li>
          </ol>
          
          <p>If you have any questions in the meantime, feel free to reply to this email.</p>
          
          <p>Thanks for your interest in partnering with Boomlify!</p>
          
          <p style="margin-top: 30px; padding-top: 15px; border-top: 1px solid #eaeaea; font-size: 14px; color: #666;">
            <em>This is an automated message. Please do not reply to this specific email.</em>
          </p>
        </div>
      `;
      
      await smtpManager.sendEmail(
        email, // Send to the submitter
        'Boomlify: Your Guest Post Request Received',
        confirmationHtml
      );
      
      // Log the submission
      await connection.query(`
        INSERT INTO activity_log (
          activity_type, user_id, details, ip_address, created_at
        ) VALUES (?, ?, ?, ?, NOW())
      `, [
        'guest_post_submission',
        null, // No user ID for guest submissions
        JSON.stringify({ submissionId, name: fullName, email, website: websiteUrl }),
        req.ip
      ]);
      
      await connection.commit();
      
      res.status(200).json({ 
        success: true, 
        message: 'Guest post request submitted successfully',
        submissionId
      });
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    
  } catch (error) {
    console.error('Error processing guest post submission:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while processing your request'
    });
  }
});

// Get all submissions - admin only with passphrase auth
router.get('/admin/all', checkAdminPassphrase, async (req, res) => {
  try {
    const [submissions] = await pool.query(`
      SELECT * FROM guest_post_submissions 
      ORDER BY created_at DESC
    `);
    
    res.status(200).json({ success: true, submissions });
    
  } catch (error) {
    console.error('Error fetching guest post submissions:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while fetching submissions'
    });
  }
});

// Update submission status - admin only with passphrase auth
router.put('/admin/status/:id', checkAdminPassphrase, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    
    if (!['pending', 'approved', 'rejected', 'completed'].includes(status)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid status. Must be pending, approved, rejected, or completed'
      });
    }
    
    await pool.query(`
      UPDATE guest_post_submissions 
      SET status = ?, admin_notes = ?, updated_at = NOW()
      WHERE id = ?
    `, [status, notes || null, id]);
    
    res.status(200).json({ 
      success: true, 
      message: 'Submission status updated successfully'
    });
    
  } catch (error) {
    console.error('Error updating guest post submission status:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while updating submission status'
    });
  }
});

export default router; 