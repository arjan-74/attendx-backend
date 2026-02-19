const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');

// GET /api/classes — get all classes
router.get('/', authMiddleware, (req, res) => {
  const { role, id } = req.user;

  if (role === 'student') {
    // Return only enrolled classes
    const enrolledIds = global.db.enrollments
      .filter(e => e.studentId === id)
      .map(e => e.classId);
    const classes = global.db.classes.filter(c => enrolledIds.includes(c.id));
    return res.json(classes);
  }

  if (role === 'faculty') {
    const classes = global.db.classes.filter(c => c.faculty === id);
    return res.json(classes);
  }

  // Admin sees all
  res.json(global.db.classes);
});

// GET /api/classes/:id — get single class
router.get('/:id', authMiddleware, (req, res) => {
  const cls = global.db.classes.find(c => c.id === req.params.id);
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  res.json(cls);
});

// POST /api/classes — create class (admin only)
router.post('/', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Admins only' });

  const { id, name, faculty, room, time, days } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name are required' });

  if (global.db.classes.find(c => c.id === id))
    return res.status(409).json({ error: 'Class ID already exists' });

  const newClass = { id, name, faculty, room, time, days };
  global.db.classes.push(newClass);
  res.status(201).json({ message: 'Class created', class: newClass });
});

// POST /api/classes/:id/enroll — enroll a student
router.post('/:id/enroll', authMiddleware, (req, res) => {
  const { studentId } = req.body;
  const classId = req.params.id;

  if (!global.db.classes.find(c => c.id === classId))
    return res.status(404).json({ error: 'Class not found' });

  if (global.db.enrollments.find(e => e.studentId === studentId && e.classId === classId))
    return res.status(409).json({ error: 'Student already enrolled' });

  global.db.enrollments.push({ studentId, classId });
  res.json({ message: 'Student enrolled successfully' });
});

module.exports = router;