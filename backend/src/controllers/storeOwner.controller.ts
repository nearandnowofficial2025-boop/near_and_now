import { Request, Response } from 'express';
import crypto from 'crypto';
import { supabaseAdmin } from '../config/database.js';

/**
 * Complete store owner registration after OTP verification.
 * Inserts app_users with role 'store_owner' and a store row in Supabase.
 * Ensure DB enum user_role includes 'store_owner' (run add-store-owner-role.sql if needed).
 */
export async function signupComplete(req: Request, res: Response) {
  try {
    const {
      phone,
      ownerName,
      storeName,
      storeAddress,
      radiusKm,
      email,
      latitude,
      longitude
    } = req.body;

    if (!phone || !ownerName || !storeName) {
      return res.status(400).json({
        success: false,
        error: 'Phone, owner name and store name are required'
      });
    }

    const name = String(ownerName).trim();
    const storeNameTrim = String(storeName).trim();
    const address = storeAddress ? String(storeAddress).trim() : null;
    const radius = radiusKm != null ? Number(radiusKm) : 3;
    const lat = latitude != null ? Number(latitude) : null;
    const lng = longitude != null ? Number(longitude) : null;
    const emailVal = email ? String(email).trim() || null : null;

    const { data: newUser, error: userError } = await supabaseAdmin
      .from('app_users')
      .insert({
        name,
        phone,
        email: emailVal,
        password_hash: null,
        role: 'store_owner',
        is_activated: true
      })
      .select()
      .single();

    if (userError || !newUser) {
      console.error('❌ Store owner signup: app_users insert failed', userError);
      return res.status(500).json({
        success: false,
        error: userError?.message || 'Failed to create account'
      });
    }

    const { error: storeError } = await supabaseAdmin
      .from('stores')
      .insert({
        owner_id: newUser.id,
        name: storeNameTrim,
        phone,
        address: address || '',
        latitude: lat ?? 0,
        longitude: lng ?? 0,
        is_active: true
      });

    if (storeError) {
      console.error('❌ Store owner signup: stores insert failed', storeError);
      await supabaseAdmin.from('app_users').delete().eq('id', newUser.id);
      return res.status(500).json({
        success: false,
        error: storeError.message || 'Failed to create store'
      });
    }

    const token = crypto.randomUUID();
    const { password_hash: _, ...userWithoutPassword } = newUser;

    console.log('✅ Store owner registered:', newUser.id, storeNameTrim);

    res.json({
      success: true,
      message: 'Registration complete',
      token,
      user: userWithoutPassword
    });
  } catch (error: any) {
    console.error('❌ Store owner signup error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Registration failed'
    });
  }
}
