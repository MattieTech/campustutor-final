# ✅ Admin Panel Setup Checklist

## Database Setup (Required First)
- [ ] Open Supabase Dashboard
- [ ] Go to SQL Editor
- [ ] Copy & run the table creation scripts from ADMIN_SETUP.md
  - [ ] Add columns to `profiles` table (role, status, last_login, banned_reason, banned_at, banned_by)
  - [ ] Create `activity_logs` table
  - [ ] Create indexes on activity_logs

## Create Your First Admin
- [ ] Sign up on the app or identify your user email
- [ ] In Supabase SQL Editor, run:
  ```sql
  UPDATE profiles SET role = 'admin' WHERE email = 'your-email@example.com';
  ```
- [ ] Log in to the app

## Access Admin Panel
- [ ] Go to: `http://localhost:3000/pages/admin.html`
- [ ] Log in with your admin account
- [ ] You should see the Dashboard with stats

## Test Admin Features
- [ ] ✓ View all users
- [ ] ✓ Search and filter users
- [ ] ✓ View user activity
- [ ] ✓ Test ban/unban user
- [ ] ✓ Test password reset
- [ ] ✓ Test promote user to admin

## Frontend Updates (Optional but Recommended)
- [ ] Add link to admin panel in your main dashboard/navbar
  ```html
  <a href="/pages/admin.html" class="btn btn-primary">Admin Panel</a>
  ```
- [ ] Add admin-only access to navbar for admins only

## Security Review
- [ ] Verify admin authentication works
- [ ] Test that banned users cannot login
- [ ] Review activity logs for any suspicious behavior
- [ ] Backup your Supabase database

## Deployment
- [ ] Test on localhost first ✓
- [ ] Deploy to production (Vercel/hosting)
- [ ] Update your `.env` with correct Supabase keys
- [ ] Test admin panel on production

## Files Created/Modified
✅ Backend:
  - `/backend/routes/admin.js` - Admin API endpoints
  - `/backend/server.js` - Added admin routes

✅ Frontend:
  - `/frontend/pages/admin.html` - Admin dashboard UI
  - `/frontend/js/admin.js` - Admin panel functionality
  - `/frontend/css/admin.css` - Admin panel styling
  - `/backend/routes/auth.js` - Updated with login tracking

✅ Documentation:
  - `/ADMIN_SETUP.md` - Detailed setup guide
  - `/ADMIN_CHECKLIST.md` - This file

## API Endpoints Available
- `GET /api/admin/users` - List all users
- `POST /api/admin/users/:userId/ban` - Ban user
- `POST /api/admin/users/:userId/unban` - Unban user
- `DELETE /api/admin/users/:userId` - Delete user
- `POST /api/admin/users/:userId/reset-password` - Reset password
- `POST /api/admin/users/:userId/set-role` - Change role
- `GET /api/admin/users/:userId/activity` - Get user activity

---
**Note**: Make sure your server is running before accessing the admin panel!
