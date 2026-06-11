# 🔐 Admin Panel Setup Guide

## Overview
Your CampusTutor AI now has a complete admin panel for managing users, banning fake accounts, and tracking activities.

## 📋 Database Tables Required

You need to create these tables in your **Supabase Dashboard**:

### 1. Update `profiles` Table
Add these columns to your existing `profiles` table:

```sql
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user'; -- 'user' or 'admin'
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'; -- 'active', 'banned', 'pending'
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS banned_reason TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS banned_by UUID;
```

### 2. Create `activity_logs` Table
```sql
CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  admin_id UUID NOT NULL,
  action TEXT NOT NULL, -- 'login', 'signup', 'ban_user', 'delete_user', 'reset_password', etc.
  details TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_activity_user ON activity_logs(user_id);
CREATE INDEX idx_activity_admin ON activity_logs(admin_id);
CREATE INDEX idx_activity_created ON activity_logs(created_at);
```

## 🚀 Setup Steps

### Step 1: Create Admin User
1. Sign up normally on the app
2. Go to Supabase Dashboard → SQL Editor
3. Run this query to make your account an admin:
```sql
UPDATE profiles SET role = 'admin' WHERE email = 'your-email@example.com';
```

### Step 2: Access Admin Panel
- Navigate to: `http://localhost:3000/pages/admin.html`
- Log in with your admin account
- You'll see the dashboard with all admin features

### Step 3: Add More Admins
Once logged into the admin panel, you can:
- Find a user in the "Users" section
- Click the "..." menu
- Select "Make Admin" to grant admin privileges

## 📊 Admin Panel Features

### Dashboard
- **Total Users**: Count of all registered users
- **Active Users**: Users with active status
- **Banned Users**: Suspended accounts
- **Recent Signups**: Latest registered users

### User Management
- **View all users** with their details
- **Search & filter** by name, email, or status
- **Ban users** with a reason (they can't login)
- **Unban users** (restore access)
- **Delete users** (permanent removal from database)
- **Reset passwords** (set new temporary password)
- **Promote to Admin** (grant admin privileges)
- **Demote Admin** (remove admin privileges)

### Activity Logs
- Track all admin actions
- Filter by action type and date
- View user activity history

## 🔒 Security Notes

1. **Admin Access**: Only users with `role = 'admin'` can access the panel
2. **Token Validation**: All requests require a valid JWT token
3. **Banned Users**: Cannot login even with correct password
4. **Audit Trail**: All admin actions are logged in `activity_logs`

## 🛠️ API Endpoints

All endpoints require Authorization header with your JWT token:

```bash
Authorization: Bearer YOUR_JWT_TOKEN
```

### User Management
- `GET /api/admin/users` - List all users
- `POST /api/admin/users/:userId/ban` - Ban a user
- `POST /api/admin/users/:userId/unban` - Unban a user
- `DELETE /api/admin/users/:userId` - Delete a user
- `POST /api/admin/users/:userId/reset-password` - Reset password
- `POST /api/admin/users/:userId/set-role` - Change user role

### Activity
- `GET /api/admin/users/:userId/activity` - Get user activity log

## 📝 Example: Ban a User

```javascript
// Ban a user via API
const userId = "user-uuid";
const token = localStorage.getItem("authToken");

fetch(`/api/admin/users/${userId}/ban`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    reason: "Spamming" 
  })
})
.then(res => res.json())
.then(data => console.log(data));
```

## ⚠️ Important Tips

1. **Backup First**: Always backup your Supabase data before making changes
2. **Test in Dev**: Test admin features on a test account first
3. **Use Strong Passwords**: When resetting passwords, use secure ones
4. **Audit Logs**: Regularly review activity logs for suspicious behavior
5. **Admin Accounts**: Keep admin accounts secure - don't share credentials

## 🐛 Troubleshooting

### "Admin access required" Error
- Make sure your user has `role = 'admin'` in the profiles table
- Check that you're logged in and the token is valid

### Can't see users in the panel
- Verify the `/api/admin/users` endpoint is working
- Check your browser console for errors
- Ensure your JWT token hasn't expired

### Tables not created
- Log into Supabase Dashboard
- Go to SQL Editor
- Run the table creation scripts above
- Make sure you're using the correct Supabase URL and keys

## 📞 Need Help?
Check the admin panel for real-time user statistics and implement customizations as needed!
