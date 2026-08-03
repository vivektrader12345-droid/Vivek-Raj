import React, { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { Settings as SettingsIcon, User, Shield, Palette, Bell, Save } from 'lucide-react'
import toast from 'react-hot-toast'

function Settings() {
  const { user, updateProfile, updateSettings, changePassword } = useAuth()

  const [activeTab, setActiveTab] = useState('profile')
  const [profileForm, setProfileForm] = useState({
    fullName: user?.fullName || '',
    email: user?.email || '',
  })
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  })
  const [settings, setSettings] = useState(user?.settings || {
    currency: 'USD',
    theme: 'dark',
    notifications: true,
    emailAlerts: false,
    defaultPair: 'BTC/USDT',
    riskPerTrade: 2,
  })

  const handleUpdateProfile = (e) => {
    e.preventDefault()
    if (!profileForm.fullName.trim()) {
      toast.error('Name cannot be empty')
      return
    }
    updateProfile({ fullName: profileForm.fullName.trim() })
    toast.success('Profile updated!')
  }

  const handleChangePassword = (e) => {
    e.preventDefault()
    if (!passwordForm.currentPassword || !passwordForm.newPassword || !passwordForm.confirmPassword) {
      toast.error('Please fill in all fields')
      return
    }
    if (passwordForm.newPassword.length < 6) {
      toast.error('New password must be at least 6 characters')
      return
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      toast.error('Passwords do not match')
      return
    }
    try {
      changePassword(passwordForm.currentPassword, passwordForm.newPassword)
      toast.success('Password changed successfully!')
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
    } catch (err) {
      toast.error(err.message)
    }
  }

  const handleUpdateSettings = () => {
    updateSettings(settings)
    toast.success('Settings saved!')
  }

  const tabs = [
    { id: 'profile', label: 'Profile', icon: User },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'preferences', label: 'Preferences', icon: Palette },
    { id: 'notifications', label: 'Notifications', icon: Bell },
  ]

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl lg:text-3xl font-bold text-white flex items-center gap-3">
          <SettingsIcon className="text-[#e94560]" /> Settings
        </h1>
        <p className="text-gray-400 mt-1 text-sm">Manage your account and preferences</p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setActiveTab(id)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
              activeTab === id
                ? 'bg-[#e94560]/20 text-[#e94560] border border-[#e94560]/30'
                : 'text-gray-400 hover:text-white hover:bg-[#0f3460]/20 border border-transparent'
            }`}>
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      {/* Profile Tab */}
      {activeTab === 'profile' && (
        <div className="glass-card p-6">
          <h2 className="text-white font-semibold mb-4">Profile Information</h2>
          <form onSubmit={handleUpdateProfile} className="space-y-4">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[#e94560] to-[#f5a623] flex items-center justify-center text-2xl font-bold text-white">
                {user?.fullName?.charAt(0) || 'U'}
              </div>
              <div>
                <p className="text-white font-medium">{user?.fullName}</p>
                <p className="text-gray-400 text-sm">{user?.email}</p>
                <p className="text-gray-500 text-xs mt-1">Member since {new Date(user?.createdAt).toLocaleDateString()}</p>
              </div>
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Full Name</label>
              <input type="text" value={profileForm.fullName} onChange={(e) => setProfileForm(prev => ({ ...prev, fullName: e.target.value }))}
                className="input-field" placeholder="Your full name" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Email</label>
              <input type="email" value={profileForm.email} disabled className="input-field opacity-50 cursor-not-allowed" />
              <p className="text-gray-500 text-xs mt-1">Email cannot be changed</p>
            </div>
            <button type="submit" className="btn-primary flex items-center justify-center gap-2 max-w-xs">
              <Save size={16} /> Save Profile
            </button>
          </form>
        </div>
      )}

      {/* Security Tab */}
      {activeTab === 'security' && (
        <div className="glass-card p-6">
          <h2 className="text-white font-semibold mb-4">Change Password</h2>
          <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Current Password</label>
              <input type="password" value={passwordForm.currentPassword}
                onChange={(e) => setPasswordForm(prev => ({ ...prev, currentPassword: e.target.value }))}
                className="input-field" placeholder="Enter current password" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">New Password</label>
              <input type="password" value={passwordForm.newPassword}
                onChange={(e) => setPasswordForm(prev => ({ ...prev, newPassword: e.target.value }))}
                className="input-field" placeholder="Enter new password" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Confirm New Password</label>
              <input type="password" value={passwordForm.confirmPassword}
                onChange={(e) => setPasswordForm(prev => ({ ...prev, confirmPassword: e.target.value }))}
                className="input-field" placeholder="Confirm new password" />
            </div>
            <div className="flex gap-3 max-w-md">
              <button type="submit" className="flex-1 btn-primary flex items-center justify-center gap-2">
                <Shield size={16} /> Change Password
              </button>
              <button type="button" onClick={() => {
                const email = user?.email
                if (!email) return
                const confirmEmail = prompt(`Enter your registered email to confirm reset:`)
                if (confirmEmail && confirmEmail.toLowerCase() === email.toLowerCase()) {
                  const newPass = prompt('Enter new password (min 6 characters):')
                  if (newPass && newPass.length >= 6) {
                    const confirmPass = prompt('Confirm new password:')
                    if (newPass === confirmPass) {
                      const users = JSON.parse(localStorage.getItem('vmt_users') || '[]')
                      const idx = users.findIndex(u => u.email.toLowerCase() === email.toLowerCase())
                      if (idx !== -1) {
                        users[idx].password = newPass
                        localStorage.setItem('vmt_users', JSON.stringify(users))
                        toast.success('Password reset successfully!')
                      }
                    } else {
                      toast.error('Passwords do not match')
                    }
                  } else {
                    toast.error('Password must be at least 6 characters')
                  }
                } else if (confirmEmail) {
                  toast.error('Email does not match your account')
                }
              }} className="flex-1 flex items-center justify-center gap-2 py-3 bg-orange-500/20 text-orange-400 border border-orange-500/30 rounded-xl hover:bg-orange-500/30 transition-all text-sm font-medium">
                🔑 Reset Password
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Preferences Tab */}
      {activeTab === 'preferences' && (
        <div className="glass-card p-6">
          <h2 className="text-white font-semibold mb-4">Trading Preferences</h2>
          <div className="space-y-4 max-w-md">
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Default Currency</label>
              <select value={settings.currency} onChange={(e) => setSettings(prev => ({ ...prev, currency: e.target.value }))} className="input-field">
                <option value="USD">USD ($)</option>
                <option value="EUR">EUR (€)</option>
                <option value="GBP">GBP (£)</option>
                <option value="INR">INR (₹)</option>
                <option value="JPY">JPY (¥)</option>
              </select>
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Default Trading Pair</label>
              <select value={settings.defaultPair} onChange={(e) => setSettings(prev => ({ ...prev, defaultPair: e.target.value }))} className="input-field">
                <option value="BTC/USDT">BTC/USDT</option>
                <option value="ETH/USDT">ETH/USDT</option>
                <option value="SOL/USDT">SOL/USDT</option>
                <option value="EUR/USD">EUR/USD</option>
                <option value="GBP/USD">GBP/USD</option>
              </select>
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Risk Per Trade (%)</label>
              <input type="number" value={settings.riskPerTrade} min="0.1" max="100" step="0.1"
                onChange={(e) => setSettings(prev => ({ ...prev, riskPerTrade: parseFloat(e.target.value) }))}
                className="input-field" />
            </div>
            <button onClick={handleUpdateSettings} className="btn-primary flex items-center justify-center gap-2 max-w-xs">
              <Save size={16} /> Save Preferences
            </button>
          </div>
        </div>
      )}

      {/* Notifications Tab */}
      {activeTab === 'notifications' && (
        <div className="glass-card p-6">
          <h2 className="text-white font-semibold mb-4">Notification Settings</h2>
          <div className="space-y-4 max-w-md">
            <div className="flex items-center justify-between p-4 bg-[#0a0a1a] rounded-xl border border-[#0f3460]">
              <div>
                <p className="text-white text-sm font-medium">Browser Notifications</p>
                <p className="text-gray-500 text-xs mt-0.5">Get notified when alerts trigger</p>
              </div>
              <button onClick={() => setSettings(prev => ({ ...prev, notifications: !prev.notifications }))}
                className={`w-12 h-6 rounded-full transition-all relative ${settings.notifications ? 'bg-[#e94560]' : 'bg-[#0f3460]'}`}>
                <div className={`w-5 h-5 bg-white rounded-full absolute top-0.5 transition-all ${settings.notifications ? 'right-0.5' : 'left-0.5'}`}></div>
              </button>
            </div>
            <div className="flex items-center justify-between p-4 bg-[#0a0a1a] rounded-xl border border-[#0f3460]">
              <div>
                <p className="text-white text-sm font-medium">Email Alerts</p>
                <p className="text-gray-500 text-xs mt-0.5">Receive trade summaries via email</p>
              </div>
              <button onClick={() => setSettings(prev => ({ ...prev, emailAlerts: !prev.emailAlerts }))}
                className={`w-12 h-6 rounded-full transition-all relative ${settings.emailAlerts ? 'bg-[#e94560]' : 'bg-[#0f3460]'}`}>
                <div className={`w-5 h-5 bg-white rounded-full absolute top-0.5 transition-all ${settings.emailAlerts ? 'right-0.5' : 'left-0.5'}`}></div>
              </button>
            </div>
            <button onClick={handleUpdateSettings} className="btn-primary flex items-center justify-center gap-2 max-w-xs">
              <Save size={16} /> Save Settings
            </button>
          </div>
        </div>
      )}

      {/* Danger Zone */}
      <div className="glass-card p-6 border-red-500/20">
        <h2 className="text-red-400 font-semibold mb-2">Danger Zone</h2>
        <p className="text-gray-500 text-sm mb-4">These actions are irreversible</p>
        <div className="flex flex-wrap gap-3">
          <button onClick={() => {
            if (window.confirm('This will delete ALL your trade data. Are you sure?')) {
              localStorage.removeItem('vmt_trades')
              localStorage.removeItem('vmt_alerts')
              toast.success('All data cleared. Refresh the page.')
              window.location.reload()
            }
          }} className="px-4 py-2 bg-red-500/10 text-red-400 border border-red-500/30 rounded-lg text-sm hover:bg-red-500/20 transition-all">
            Delete All Trade Data
          </button>
          <button onClick={() => {
            if (window.confirm('This will delete your account and all data. Are you sure?')) {
              localStorage.clear()
              window.location.reload()
            }
          }} className="px-4 py-2 bg-red-500/10 text-red-400 border border-red-500/30 rounded-lg text-sm hover:bg-red-500/20 transition-all">
            Delete Account
          </button>
        </div>
      </div>

    </div>
  )
}

export default Settings
