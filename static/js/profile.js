// Set back button based on which profile page is loaded
(function setBackButton() {
  const page = window.location.pathname.split('/').pop();
  const backBtn = document.querySelector('.back-btn');
  if (!backBtn) return;

  if (page === 'parent-profile.html') {
    backBtn.href = 'parent-dashboard.html';
    backBtn.innerHTML = '<i class="fas fa-arrow-left"></i> Back to Parent Dashboard';
  } else if (page === 'teacher-profile.html') {
    backBtn.href = 'teacher-dashboard.html';
    backBtn.innerHTML = '<i class="fas fa-arrow-left"></i> Back to Teacher Dashboard';
  } else if (page === 'finance-profile.html') {
    backBtn.href = 'finance-dashboard.html';
    backBtn.innerHTML = '<i class="fas fa-arrow-left"></i> Back to Finance Dashboard';
  } else {
    backBtn.href = 'dashboard.html';
    backBtn.innerHTML = '<i class="fas fa-arrow-left"></i> Back to Dashboard';
  }
})();

const API_BASE_URL = "http://localhost:5000";

    // Load profile from backend
    window.addEventListener('load', async () => {
      const storedUser = sessionStorage.getItem('currentUser');
      if (!storedUser) {
        window.location.href = 'login.html';
        return;
      }

      const user = JSON.parse(storedUser);
      const email = user.email;

      try {
        const response = await fetch(`${API_BASE_URL}/api/profile?email=${encodeURIComponent(email)}`);
        if (!response.ok) {
          throw new Error('Failed to load profile');
        }
        const data = await response.json();

        // Update displayed values
        document.getElementById('profileName').textContent = data.fullName || 'Unknown';
        document.getElementById('profileFullName').textContent = data.fullName || '-';
        document.getElementById('profileEmail').textContent = data.email || '-';
        document.getElementById('profilePhone').textContent = data.phone || 'Not provided';
        document.getElementById('profileDOB').textContent = data.dateOfBirth || 'Not provided';
        document.getElementById('profileGender').textContent = data.gender || 'Not specified';
        document.getElementById('profileAddress').textContent = data.address || 'Not provided';
        document.getElementById('profileCreated').textContent = data.createdAt || 'Unknown';

      } catch (err) {
        console.error("Error loading profile:", err);
        alert("Could not load profile. Please try again.");
      }
    });

    // Open Edit Profile modal
    document.getElementById('editProfileBtn').addEventListener('click', async () => {
      const user = JSON.parse(sessionStorage.getItem('currentUser') || '{}');

      document.getElementById('editFullName').value = user.fullName || '';
      document.getElementById('editPhone').value = user.phone || '';
      document.getElementById('editDOB').value = user.dateOfBirth || '';
      document.getElementById('editGender').value = user.gender || '';
      document.getElementById('editAddress').value = user.address || '';

      document.getElementById('editModal').style.display = 'flex';
    });

    // Close Edit modal
    function closeEditModal() {
      document.getElementById('editModal').style.display = 'none';
    }

    // Save edited profile - REAL backend update
    document.getElementById('editProfileForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      const storedUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
      const email = storedUser.email;

      if (!email) {
        alert('Session error. Please log in again.');
        return;
      }

      const updated = {
        email,
        fullName: document.getElementById('editFullName').value.trim(),
        phone: document.getElementById('editPhone').value.trim(),
        date_of_birth: document.getElementById('editDOB').value || null,
        gender: document.getElementById('editGender').value || null,
        address: document.getElementById('editAddress').value.trim() || null
      };

      try {
        const response = await fetch(`${API_BASE_URL}/api/profile`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updated)
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.message || 'Failed to update profile');
        }

        alert(result.message || 'Profile updated successfully!');

        // Update sessionStorage for instant display
        const current = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
        sessionStorage.setItem('currentUser', JSON.stringify({ ...current, ...updated }));

        closeEditModal();
        location.reload();

      } catch (err) {
        alert(err.message || 'Something went wrong');
      }
    });

    // Open Change Password modal
    document.getElementById('changePasswordBtn').addEventListener('click', () => {
      document.getElementById('passwordModal').style.display = 'flex';
    });

    // Close Password modal
    function closePasswordModal() {
      document.getElementById('passwordModal').style.display = 'none';
      document.getElementById('changePasswordForm').reset();
    }

    // Change password - REAL backend update
    document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      const current = document.getElementById('currentPassword').value;
      const newPass = document.getElementById('newPassword').value;
      const confirm = document.getElementById('confirmPassword').value;

      if (newPass !== confirm) {
        alert('New password and confirmation do not match!');
        return;
      }

      if (newPass.length < 6) {
        alert('Password must be at least 6 characters long.');
        return;
      }

      const user = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
      const email = user.email;

      if (!email) {
        alert('Session error. Please log in again.');
        return;
      }

      try {
        const response = await fetch(`${API_BASE_URL}/api/change-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            currentPassword: current,
            newPassword: newPass
          })
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.message || 'Failed to change password');
        }

        alert(result.message || 'Password changed successfully!');

        closePasswordModal();
        document.getElementById('changePasswordForm').reset();

        // Optional: force re-login after password change
        // sessionStorage.removeItem('currentUser');
        // window.location.href = 'login.html';

      } catch (err) {
        alert(err.message || 'Something went wrong');
      }
    });